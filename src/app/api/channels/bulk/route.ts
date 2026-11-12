import type { ExtraChannel } from '@/lib/channels/types';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { sendChannelToContact, validateChannelText } from '@/lib/channels/send';
import { ChannelError, isExtraChannel } from '@/lib/channels/types';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';

export const maxDuration = 60;

const BATCH = { sms: 20, rcs: 20, email: 8 } as const;
// EmailJS allows 1 request / second.
const EMAIL_GAP_MS = 1100;

/**
 * POST /api/channels/bulk
 * Body: { channel, content_text, subject?, tag_id?, cursor? }
 *
 * Sends one batch of a multichannel campaign and returns the next
 * cursor; the dashboard loops until `done`. `{{name}}` in the text /
 * subject is replaced with the contact's first name. Contacts without
 * a phone (sms/rcs) or email are skipped, not failed.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');
    const limit = checkRateLimit(`channel-bulk:${userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || !isExtraChannel(body.channel)) {
      return NextResponse.json({ error: 'A valid channel is required' }, { status: 400 });
    }
    const channel: ExtraChannel = body.channel;
    const template = validateChannelText(channel, body.content_text);
    const subjectTpl: string = typeof body.subject === 'string' ? body.subject : '';

    const column = channel === 'email' ? 'email' : 'phone';
    const select =
      'id, name, phone, email' + (body.tag_id ? ', contact_tags!inner(tag_id)' : '');
    let q = supabaseAdmin()
      .from('contacts')
      .select(select)
      .eq('account_id', accountId)
      .neq(column, '')
      .not(column, 'is', null)
      .order('id', { ascending: true })
      .limit(BATCH[channel]);
    if (body.tag_id) q = q.eq('contact_tags.tag_id', body.tag_id);
    if (typeof body.cursor === 'string' && body.cursor) q = q.gt('id', body.cursor);

    const { data, error } = await q;
    if (error) throw new ChannelError('db_error', error.message, 500);
    const contacts = (data ?? []) as unknown as {
      id: string;
      name: string | null;
      phone: string | null;
      email: string | null;
    }[];

    // Record the campaign in Broadcasts so it shows up in analytics.
    // Created as 'sent' (counts accumulate per batch) so the WhatsApp
    // resume job never treats it as a stuck 'sending' broadcast.
    const db = supabaseAdmin();
    let broadcastId: string | null =
      typeof body.broadcast_id === 'string' && body.broadcast_id ? body.broadcast_id : null;
    if (!broadcastId) {
      const ownerId = await resolveAuditUserId(db, accountId);
      const { data: b } = await db
        .from('broadcasts')
        .insert({
          account_id: accountId,
          user_id: ownerId,
          name: `${channel.toUpperCase()} campaign — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          template_name: template.slice(0, 80),
          channel,
          status: 'sent',
          total_recipients: 0,
          sent_count: 0,
          delivered_count: 0,
          failed_count: 0,
        })
        .select('id')
        .single();
      broadcastId = (b as { id: string } | null)?.id ?? null;
    }

    let sent = 0;
    const failures: { contact: string; error: string }[] = [];
    for (const c of contacts) {
      const first = (c.name ?? '').trim().split(/\s+/)[0] || 'there';
      const fill = (s: string) => s.replace(/\{\{\s*name\s*\}\}/gi, first);
      try {
        await sendChannelToContact(accountId, c.id, {
          channel,
          text: fill(template),
          subject: fill(subjectTpl),
          senderId: userId,
          baseUrl: new URL(request.url).origin,
        });
        sent += 1;
      } catch (err) {
        failures.push({
          contact: c.name || c.phone || c.email || c.id,
          error: err instanceof Error ? err.message : 'Send failed',
        });
      }
      if (channel === 'email') await new Promise((r) => setTimeout(r, EMAIL_GAP_MS));
    }

    const done = contacts.length < BATCH[channel];
    if (broadcastId) {
      await db.rpc('bump_channel_broadcast', {
        p_id: broadcastId,
        p_account_id: accountId,
        p_total: contacts.length,
        p_sent: sent,
        p_failed: failures.length,
      });
    }
    return NextResponse.json({
      broadcast_id: broadcastId,
      sent,
      failed: failures.length,
      failures: failures.slice(0, 5),
      processed: contacts.length,
      next_cursor: done ? null : contacts[contacts.length - 1].id,
      done,
    });
  } catch (err) {
    if (err instanceof ChannelError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
