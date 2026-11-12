import { NextResponse } from 'next/server';

import { loadChannelConfigByToken } from '@/lib/channels/config';
import { applyDeliveryReceipt, recordInboundMessage } from '@/lib/channels/inbound';
import { isExtraChannel } from '@/lib/channels/types';

export const maxDuration = 30;

// Inbound SMS / RCS + delivery receipts.
//
// URL:  /api/channels/webhook/<sms|rcs|email>/<inbound_token>
// The token (shown in Settings → Channels) is the secret: it both
// authenticates the caller and tells us which account the traffic is
// for. Point your provider's "incoming message" and "status callback"
// webhooks at this URL.
//
//   Twilio  — application/x-www-form-urlencoded (From, Body, MessageSid,
//             MessageStatus, ErrorMessage). Reply is empty TwiML.
//   Email   — any inbound-parse/forwarding service (Mailgun, SendGrid,
//             Resend, Postmark, Zapier…) posting JSON or form data with
//             { from, text, subject? }; replies land in the inbox.
//   Generic — JSON. Inbound: { from, text, id? }.
//             Receipt: { id, status, error? }.

const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ channel: string; token: string }> }
) {
  const { channel, token } = await params;
  if (!isExtraChannel(channel)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const config = await loadChannelConfigByToken(channel, token);
  if (!config) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const contentType = request.headers.get('content-type') ?? '';
  const isForm = contentType.includes('application/x-www-form-urlencoded');

  let data: Record<string, unknown>;
  try {
    if (isForm) {
      data = Object.fromEntries(new URLSearchParams(await request.text()));
    } else {
      const parsed = await request.json();
      data = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    }
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  // Twilio sends "SmsStatus=received" with Body for inbound, and
  // "MessageStatus=<state>" (no inbound flag) for delivery receipts.
  const twilioStatus = str(data.MessageStatus);
  const isTwilioReceipt =
    !!twilioStatus && str(data.SmsStatus).toLowerCase() !== 'received';

  try {
    if (isTwilioReceipt) {
      await applyDeliveryReceipt(
        config.accountId,
        channel,
        str(data.MessageSid) || str(data.SmsSid),
        twilioStatus,
        str(data.ErrorMessage) || (str(data.ErrorCode) ? `Error ${str(data.ErrorCode)}` : null)
      );
    } else if (!isForm && str(data.status) && str(data.id) && !str(data.from)) {
      await applyDeliveryReceipt(
        config.accountId,
        channel,
        str(data.id),
        str(data.status),
        str(data.error) || null
      );
    } else {
      const from = str(data.From) || str(data.from) || str(data.sender) || str(data.email);
      const text = str(data.Body) || str(data.text) || str(data['stripped-text']) || str(data.message) || str(data.body);
      if (from && text) {
        await recordInboundMessage(config.accountId, {
          channel,
          from,
          text,
          providerMessageId: str(data.MessageSid) || str(data.id) || null,
        });
      }
    }
  } catch (err) {
    console.error('[channels/webhook] processing failed:', err instanceof Error ? err.message : err);
    // 500 so the provider retries; inbound inserts are idempotent.
    return NextResponse.json({ error: 'Processing failed' }, { status: 500 });
  }

  if (isForm) {
    return new Response(TWIML_EMPTY, { status: 200, headers: { 'Content-Type': 'text/xml' } });
  }
  return NextResponse.json({ success: true });
}
