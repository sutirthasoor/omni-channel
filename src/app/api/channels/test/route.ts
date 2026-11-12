import type { ExtraChannel } from '@/lib/channels/types';
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadChannelConfig } from '@/lib/channels/config';
import { sendViaProvider } from '@/lib/channels/providers';
import {
  CHANNEL_LABEL,
  ChannelError,
  isExtraChannel,
} from '@/lib/channels/types';

/**
 * POST /api/channels/test — admin. Sends a one-off test message through
 * the saved provider config to a number / address the admin types in.
 * Body: { channel, to }
 */
export async function POST(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (!body || !isExtraChannel(body.channel) || typeof body.to !== 'string' || !body.to.trim()) {
      return NextResponse.json({ error: 'channel and to are required' }, { status: 400 });
    }
    const channel: ExtraChannel = body.channel;
    const config = await loadChannelConfig(accountId, channel);
    if (!config) {
      return NextResponse.json(
        { error: `${CHANNEL_LABEL[channel]} is not connected yet — save the settings first.` },
        { status: 400 }
      );
    }
    await sendViaProvider(channel, config.provider, config.creds, {
      to: body.to.trim(),
      text: `Test ${CHANNEL_LABEL[channel]} message from your CRM. If you can read this, the channel works.`,
      subject: 'CRM channel test',
      recipientName: 'Test recipient',
    });
    return NextResponse.json({ success: true });
  } catch (err) {
    if (err instanceof ChannelError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return toErrorResponse(err);
  }
}
