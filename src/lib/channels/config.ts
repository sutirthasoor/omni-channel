// ============================================================
// channel_configs persistence. Secrets are AES-256-GCM encrypted
// with the same ENCRYPTION_KEY the WhatsApp token uses, and are
// NEVER returned to the browser — the UI only learns *which* secret
// fields are set.
//
// Server-only. Callers must have authorised the request already
// (admin for writes, agent for send); every query is scoped by
// `accountId` because the service-role client bypasses RLS.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import {
  ChannelError,
  isValidProvider,
  providerFields,
  type ChannelCredentials,
  type ExtraChannel,
} from './types';

export interface ResolvedChannelConfig {
  id: string;
  channel: ExtraChannel;
  provider: string;
  /** Settings + decrypted secrets merged — for provider adapters only. */
  creds: ChannelCredentials;
  inboundToken: string;
}

interface Row {
  id: string;
  channel: ExtraChannel;
  provider: string;
  settings: Record<string, string> | null;
  secrets_encrypted: string | null;
  inbound_token: string;
  status: 'connected' | 'disconnected';
  updated_at: string;
}

function decodeSecrets(row: Row): Record<string, string> {
  if (!row.secrets_encrypted) return {};
  try {
    return JSON.parse(decrypt(row.secrets_encrypted)) as Record<string, string>;
  } catch {
    throw new ChannelError(
      'token_corrupted',
      'Saved channel credentials could not be decrypted. Re-save them in Settings → Channels.',
      500
    );
  }
}

/** Connected config for (account, channel) with decrypted credentials. */
export async function loadChannelConfig(
  accountId: string,
  channel: ExtraChannel
): Promise<ResolvedChannelConfig | null> {
  const { data } = await supabaseAdmin()
    .from('channel_configs')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .eq('status', 'connected')
    .maybeSingle();
  if (!data) return null;
  const row = data as Row;
  return {
    id: row.id,
    channel,
    provider: row.provider,
    creds: { ...(row.settings ?? {}), ...decodeSecrets(row) },
    inboundToken: row.inbound_token,
  };
}

/** Look a config up by the token embedded in its webhook URL. */
export async function loadChannelConfigByToken(
  channel: ExtraChannel,
  token: string
): Promise<(ResolvedChannelConfig & { accountId: string }) | null> {
  if (!/^[a-f0-9]{32,64}$/i.test(token)) return null;
  const { data } = await supabaseAdmin()
    .from('channel_configs')
    .select('*')
    .eq('inbound_token', token)
    .eq('channel', channel)
    .maybeSingle();
  if (!data) return null;
  const row = data as Row & { account_id: string };
  return {
    id: row.id,
    accountId: row.account_id,
    channel,
    provider: row.provider,
    creds: { ...(row.settings ?? {}), ...decodeSecrets(row) },
    inboundToken: row.inbound_token,
  };
}

/** Browser-safe view of one saved channel. */
export interface ChannelSummary {
  channel: ExtraChannel;
  provider: string;
  status: 'connected' | 'disconnected';
  /** Non-secret values, safe to prefill the form with. */
  settings: Record<string, string>;
  /** Keys of secret fields that already have a stored value. */
  secretsSet: string[];
  inboundToken: string;
  updatedAt: string;
}

export async function listChannelSummaries(accountId: string): Promise<ChannelSummary[]> {
  const { data, error } = await supabaseAdmin()
    .from('channel_configs')
    .select('*')
    .eq('account_id', accountId);
  if (error) throw new ChannelError('db_error', error.message, 500);
  return ((data ?? []) as Row[]).map((row) => {
    let secretKeys: string[] = [];
    try {
      secretKeys = Object.entries(decodeSecrets(row))
        .filter(([, v]) => !!v)
        .map(([k]) => k);
    } catch {
      secretKeys = [];
    }
    return {
      channel: row.channel,
      provider: row.provider,
      status: row.status,
      settings: row.settings ?? {},
      secretsSet: secretKeys,
      inboundToken: row.inbound_token,
      updatedAt: row.updated_at,
    };
  });
}

/**
 * Create or update a channel config. Blank secret fields keep the
 * stored value (when the provider is unchanged), so the UI never has
 * to hold a secret it was not given.
 */
export async function saveChannelConfig(
  accountId: string,
  channel: ExtraChannel,
  provider: string,
  values: Record<string, unknown>
): Promise<void> {
  if (!isValidProvider(channel, provider)) {
    throw new ChannelError('bad_request', `Unknown provider "${provider}"`, 400);
  }
  const fields = providerFields(channel, provider);
  if (!fields) throw new ChannelError('bad_request', 'Unknown provider', 400);

  const db = supabaseAdmin();
  const { data: existing } = await db
    .from('channel_configs')
    .select('*')
    .eq('account_id', accountId)
    .eq('channel', channel)
    .maybeSingle();
  const prev = existing as Row | null;
  const sameProvider = prev?.provider === provider;
  const prevSecrets = prev && sameProvider ? decodeSecrets(prev) : {};

  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const f of fields) {
    const raw = typeof values[f.key] === 'string' ? (values[f.key] as string).trim() : '';
    if (f.secret) {
      const v = raw || prevSecrets[f.key] || '';
      if (v) secrets[f.key] = v;
      if (f.required && !v) {
        throw new ChannelError('bad_request', `${f.label} is required`, 400);
      }
    } else {
      if (f.required && !raw) {
        throw new ChannelError('bad_request', `${f.label} is required`, 400);
      }
      if (raw) settings[f.key] = raw;
    }
  }

  const now = new Date().toISOString();
  const payload = {
    provider,
    settings,
    secrets_encrypted: Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null,
    status: 'connected',
    updated_at: now,
  };

  const { error } = prev
    ? await db.from('channel_configs').update(payload).eq('id', prev.id).eq('account_id', accountId)
    : await db.from('channel_configs').insert({ account_id: accountId, channel, ...payload });
  if (error) throw new ChannelError('db_error', error.message, 500);
}

export async function deleteChannelConfig(
  accountId: string,
  channel: ExtraChannel
): Promise<void> {
  const { error } = await supabaseAdmin()
    .from('channel_configs')
    .delete()
    .eq('account_id', accountId)
    .eq('channel', channel);
  if (error) throw new ChannelError('db_error', error.message, 500);
}
