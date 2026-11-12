// ============================================================
// Inbound SMS / RCS and delivery receipts, called by the channel
// webhook route. Reuses the same contact de-dupe, one-conversation-
// per-contact rule, atomic unread bump and re-open behaviour as the
// WhatsApp webhook.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe';
import { reopenClosedConversation } from '@/lib/conversations/reopen';
import { findOrCreateConversationRow } from '@/lib/whatsapp/resolve-conversation';
import { runAutomationsForTrigger } from '@/lib/automations/engine';
import { dispatchInboundToFlows } from '@/lib/flows/engine';
import { dispatchInboundToAiReply } from '@/lib/ai/auto-reply';
import { claimFirstInboundMessage } from '@/lib/conversations/first-inbound';
import type { ExtraChannel } from './types';

export interface InboundChannelMessage {
  channel: ExtraChannel;
  /** Sender's phone (sms/rcs) or email address (email). */
  from: string;
  text: string;
  providerMessageId?: string | null;
}

/** Strip provider prefixes such as Twilio's "rcs:" / "whatsapp:". */
export function cleanPhone(raw: string): string {
  const stripped = raw.replace(/^[a-z]+:/i, '').trim();
  const digits = stripped.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

/** Returns false when the message was a duplicate delivery. */
export async function recordInboundMessage(
  accountId: string,
  msg: InboundChannelMessage
): Promise<boolean> {
  const db = supabaseAdmin();
  const isEmail = msg.channel === 'email';
  const phone = isEmail ? '' : cleanPhone(msg.from);
  const email = isEmail ? msg.from.trim().toLowerCase() : '';
  if (!phone && !email) return false;

  const ownerId = await resolveAuditUserId(db, accountId);

  let contact = phone ? await findExistingContact(db, accountId, phone) : null;
  if (!contact && email) {
    const { data: byEmail } = await db
      .from('contacts')
      .select('*')
      .eq('account_id', accountId)
      .ilike('email', email)
      .limit(1)
      .maybeSingle();
    contact = byEmail ?? null;
  }
  if (!contact) {
    const { data: created, error } = await db
      .from('contacts')
      .insert(
        isEmail
          ? { account_id: accountId, user_id: ownerId, email, name: email }
          : { account_id: accountId, user_id: ownerId, phone, name: phone }
      )
      .select('*')
      .single();
    if (error || !created) {
      if (isUniqueViolation(error) && phone) contact = await findExistingContact(db, accountId, phone);
      if (!contact) {
        console.error('[channels] inbound contact create failed:', error?.message);
        throw new Error('contact_create_failed');
      }
    } else {
      contact = created as typeof contact;
    }
  }
  const contactId = (contact as { id: string }).id;

  const conv = await findOrCreateConversationRow(db, accountId, contactId, ownerId);
  const { data: convRow } = await db
    .from('conversations')
    .select('id, status')
    .eq('id', conv.id)
    .single();

  const { error: insErr } = await db.from('messages').insert({
    conversation_id: conv.id,
    sender_type: 'customer',
    content_type: 'text',
    content_text: msg.text,
    channel: msg.channel,
    message_id: msg.providerMessageId ?? null,
    status: 'delivered',
  });
  if (insErr) {
    // (conversation_id, message_id) unique index → replayed delivery.
    if (isUniqueViolation(insErr)) return false;
    console.error('[channels] inbound insert failed:', insErr.message);
    throw new Error('message_insert_failed');
  }

  const { error: bumpErr } = await db.rpc('bump_conversation_on_inbound', {
    p_conversation_id: conv.id,
    p_last_message_text: msg.text,
  });
  if (bumpErr) console.error('[channels] conversation bump failed:', bumpErr.message);

  await db.from('conversations').update({ last_channel: msg.channel }).eq('id', conv.id);
  await reopenClosedConversation(db, convRow ?? { id: conv.id });

  // Same downstream pipeline as a WhatsApp inbound: Flows → Automations
  // → AI auto-reply. Each dispatcher owns its error handling; a failure
  // here must never make the provider retry the (already stored) message.
  try {
    const { data: fresh } = await db
      .from('conversations')
      .select('id, first_inbound_at')
      .eq('id', conv.id)
      .single();
    const isFirst = await claimFirstInboundMessage(
      db,
      (fresh as { id: string; first_inbound_at?: string | null }) ?? { id: conv.id },
      new Date().toISOString()
    );
    const flowResult = await dispatchInboundToFlows({
      accountId,
      userId: ownerId,
      contactId,
      conversationId: conv.id,
      message: { kind: 'text', text: msg.text, meta_message_id: msg.providerMessageId ?? `${msg.channel}-${Date.now()}` },
      isFirstInboundMessage: isFirst,
    });
    const triggers: string[] = [];
    if (isFirst) triggers.push('first_inbound_message');
    if (!flowResult.consumed) triggers.push('new_message_received', 'keyword_match');
    for (const triggerType of triggers) {
      await runAutomationsForTrigger({
        accountId,
        triggerType,
        contactId,
        context: { message_text: msg.text, conversation_id: conv.id },
      } as Parameters<typeof runAutomationsForTrigger>[0]).catch((e) =>
        console.error('[channels] automation dispatch failed:', e)
      );
    }
    if (!flowResult.consumed && msg.text.trim()) {
      await dispatchInboundToAiReply({
        accountId,
        conversationId: conv.id,
        contactId,
        configOwnerUserId: ownerId,
      });
    }
  } catch (e) {
    console.error('[channels] inbound dispatch failed:', e instanceof Error ? e.message : e);
  }
  return true;
}

const STATUS_MAP: Record<string, 'sent' | 'delivered' | 'failed' | 'read'> = {
  queued: 'sent',
  accepted: 'sent',
  sending: 'sent',
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  undelivered: 'failed',
  failed: 'failed',
};

/** Apply a provider delivery receipt (Twilio MessageStatus etc.). */
export async function applyDeliveryReceipt(
  accountId: string,
  channel: ExtraChannel,
  providerMessageId: string,
  rawStatus: string,
  errorText?: string | null
): Promise<void> {
  const status = STATUS_MAP[rawStatus.toLowerCase()];
  if (!status || !providerMessageId) return;
  const db = supabaseAdmin();

  // Provider ids are only unique per provider, so verify the message's
  // conversation belongs to this account before touching it.
  const { data: msgs } = await db
    .from('messages')
    .select('id, conversation_id, status')
    .eq('channel', channel)
    .eq('message_id', providerMessageId)
    .limit(5);

  // Never downgrade: delivered/read must not be overwritten by a late 'sent'.
  const blocked: string[] =
    status === 'sent' ? ['delivered', 'read', 'failed'] : status === 'delivered' ? ['read'] : [];

  for (const m of (msgs ?? []) as { id: string; conversation_id: string; status: string }[]) {
    if (blocked.includes(m.status)) continue;
    const { data: owned } = await db
      .from('conversations')
      .select('id')
      .eq('id', m.conversation_id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (!owned) continue;
    const { error } = await db
      .from('messages')
      .update({
        status,
        ...(status === 'failed'
          ? { error_title: 'Not delivered', error_details: errorText ?? null }
          : {}),
      })
      .eq('id', m.id);
    if (error) console.error('[channels] receipt update failed:', error.message);
  }
}
