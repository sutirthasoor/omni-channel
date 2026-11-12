import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { sendChannelMessage } from '@/lib/channels/send';
import { ChannelError, isExtraChannel } from '@/lib/channels/types';

/**
 * POST /api/channels/send
 * Body: { conversation_id, channel: 'sms'|'rcs'|'email', content_text, subject? }
 *
 * The SMS / RCS / Email counterpart of /api/whatsapp/send. Same auth
 * (agent role) and the same per-user send rate limit.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('agent');

    const limit = checkRateLimit(`send:${userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body?.conversation_id || !isExtraChannel(body.channel)) {
      return NextResponse.json(
        { error: 'conversation_id and a valid channel are required' },
        { status: 400 }
      );
    }

    const result = await sendChannelMessage(accountId, {
      conversationId: body.conversation_id,
      channel: body.channel,
      text: body.content_text,
      subject: body.subject,
      senderId: userId,
      baseUrl: new URL(request.url).origin,
    });

    return NextResponse.json({ success: true, message_id: result.messageId });
  } catch (err) {
    if (err instanceof ChannelError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
