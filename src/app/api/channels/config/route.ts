import { NextResponse } from 'next/server';

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import {
  deleteChannelConfig,
  listChannelSummaries,
  saveChannelConfig,
} from '@/lib/channels/config';
import { ChannelError, isExtraChannel } from '@/lib/channels/types';

function channelErrorResponse(err: unknown) {
  if (err instanceof ChannelError) {
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }
  return toErrorResponse(err);
}

/**
 * GET /api/channels/config
 *
 * Any account member can see WHICH channels are connected (the inbox
 * needs that to offer a channel picker). Only admins get the non-secret
 * settings and webhook tokens. Secrets are never returned.
 */
export async function GET() {
  try {
    const { accountId, role } = await getCurrentAccount();
    const all = await listChannelSummaries(accountId);
    const isAdmin = hasMinRole(role, 'admin');
    return NextResponse.json({
      channels: all.map((c) =>
        isAdmin
          ? c
          : { channel: c.channel, provider: c.provider, status: c.status }
      ),
    });
  } catch (err) {
    return channelErrorResponse(err);
  }
}

/** PUT /api/channels/config — admin. Body: { channel, provider, values } */
export async function PUT(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const body = await request.json().catch(() => null);
    if (!body || !isExtraChannel(body.channel) || typeof body.provider !== 'string') {
      return NextResponse.json({ error: 'channel and provider are required' }, { status: 400 });
    }
    await saveChannelConfig(accountId, body.channel, body.provider, body.values ?? {});
    return NextResponse.json({ success: true });
  } catch (err) {
    return channelErrorResponse(err);
  }
}

/** DELETE /api/channels/config?channel=sms — admin. */
export async function DELETE(request: Request) {
  try {
    const { accountId } = await requireRole('admin');
    const channel = new URL(request.url).searchParams.get('channel');
    if (!isExtraChannel(channel)) {
      return NextResponse.json({ error: 'Invalid channel' }, { status: 400 });
    }
    await deleteChannelConfig(accountId, channel);
    return NextResponse.json({ success: true });
  } catch (err) {
    return channelErrorResponse(err);
  }
}
