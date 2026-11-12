// ============================================================
// Outbound send for SMS / RCS / Email. Mirrors the shape of
// `sendMessageToConversation` (WhatsApp) — validate → resolve the
// recipient → call the provider → persist → bump the conversation —
// but never touches any WhatsApp code path.
//
// Uses the service-role client scoped by `accountId`; the calling
// route is responsible for authenticating the user (agent role).
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation';
import { loadChannelConfig } from './config';
import { sendViaProvider } from './providers';
import {
  CHANNEL_LABEL,
  CHANNEL_LIMITS,
  ChannelError,
  type ExtraChannel,
} from './types';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface SendChannelParams {
  conversationId: string;
  channel: ExtraChannel;
  text: string;
  subject?: string | null;
  senderId?: string | null;
  /** Public base URL (https://crm.example.com) for delivery receipts. */
  baseUrl?: string | null;
}

export interface SendChannelResult {
  messageId: string;
}

export function validateChannelText(channel: ExtraChannel, text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) {
    throw new ChannelError('bad_request', 'Message text is required', 400);
  }
  const max = CHANNEL_LIMITS[channel].maxChars;
  if (text.length > max) {
    throw new ChannelError(
      'bad_request',
      `${CHANNEL_LABEL[channel]} messages are limited to ${max} characters`,
      400
    );
  }
  return text;
}

export async function sendChannelMessage(
  accountId: string,
  params: SendChannelParams
): Promise<SendChannelResult> {
  const { conversationId, channel, senderId } = params;
  const text = validateChannelText(channel, params.text);
  const subject =
    channel === 'email' ? (params.subject?.trim() || '(no subject)').slice(0, 300) : null;

  const db = supabaseAdmin();

  const { data: conversation } = await db
    .from('conversations')
    .select('id, contact:contacts(id, name, phone, email)')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!conversation) throw new ChannelError('not_found', 'Conversation not found', 404);

  const contact = (Array.isArray(conversation.contact)
    ? conversation.contact[0]
    : conversation.contact) as
    | { id: string; name?: string | null; phone?: string | null; email?: string | null }
    | null;
  if (!contact) throw new ChannelError('not_found', 'Contact not found', 404);

  let to: string;
  if (channel === 'email') {
    to = (contact.email ?? '').trim();
    if (!EMAIL_RE.test(to)) {
      throw new ChannelError('bad_request', 'This contact has no valid email address', 400);
    }
  } else {
    to = (contact.phone ?? '').trim();
    if (to.replace(/\D/g, '').length < 7) {
      throw new ChannelError('bad_request', 'This contact has no valid phone number', 400);
    }
  }

  const config = await loadChannelConfig(accountId, channel);
  if (!config) {
    throw new ChannelError(
      'channel_not_configured',
      `${CHANNEL_LABEL[channel]} is not set up. An admin can connect it in Settings → Channels.`,
      400
    );
  }

  // Prefer the explicit public URL (same env the invite links use) —
  // behind a proxy the request origin may be an internal hostname.
  const base = (process.env.NEXT_PUBLIC_SITE_URL?.trim() || params.baseUrl || '').replace(/\/$/, '');
  const statusCallbackUrl =
    base && channel !== 'email'
      ? `${base}/api/channels/webhook/${channel}/${config.inboundToken}`
      : undefined;

  const result = await sendViaProvider(
    channel,
    config.provider,
    config.creds,
    { to, text, subject, recipientName: contact.name },
    { statusCallbackUrl }
  );

  const nowIso = new Date().toISOString();
  const { data: row, error } = await db
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_type: 'agent',
      sender_id: senderId ?? null,
      content_type: 'text',
      content_text: text,
      channel,
      subject,
      message_id: result.providerMessageId,
      status: 'sent',
    })
    .select('id')
    .single();
  if (error || !row) {
    throw new ChannelError(
      'db_error',
      `${CHANNEL_LABEL[channel]} message was sent but could not be saved: ${error?.message ?? 'unknown error'}`,
      500
    );
  }

  await db
    .from('conversations')
    .update({
      last_message_text: channel === 'email' ? `${subject}: ${text}`.slice(0, 200) : text,
      last_message_at: nowIso,
      last_channel: channel,
      updated_at: nowIso,
    })
    .eq('id', conversationId);

  // Same "human stepped in" rule as WhatsApp sends: pause active flows.
  try {
    await db
      .from('flow_runs')
      .update({ status: 'paused_by_agent', ended_at: nowIso, end_reason: 'agent_replied' })
      .eq('account_id', accountId)
      .eq('contact_id', contact.id)
      .eq('status', 'active');
  } catch (err) {
    console.error('[channels] pause-flows failed:', err instanceof Error ? err.message : err);
  }

  return { messageId: row.id as string };
}

/** Find-or-create the contact's conversation, then send (bulk path). */
export async function sendChannelToContact(
  accountId: string,
  contactId: string,
  params: Omit<SendChannelParams, 'conversationId'>
): Promise<SendChannelResult> {
  const db = supabaseAdmin();
  const { data: contact } = await db
    .from('contacts')
    .select('id')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (!contact) throw new ChannelError('not_found', 'Contact not found', 404);

  const ownerId = await resolveAuditUserId(db, accountId);
  const conv = await findOrCreateConversationRow(db, accountId, contactId, ownerId);
  return sendChannelMessage(accountId, { ...params, conversationId: conv.id });
}
