// ============================================================
// Provider adapters for SMS / RCS / Email. Each one is a plain
// `fetch` call — no SDK dependencies — and throws `ChannelError`
// with a human-readable message on any failure.
// ============================================================

import {
  ChannelError,
  type ChannelCredentials,
  type ChannelSendInput,
  type ChannelSendResult,
  type ExtraChannel,
} from './types';

const TIMEOUT_MS = 20_000;

export interface SendContext {
  /** Public URL the provider should POST delivery receipts to. */
  statusCallbackUrl?: string;
}

/** Dispatch to the adapter for `(channel, provider)`. */
export async function sendViaProvider(
  channel: ExtraChannel,
  provider: string,
  creds: ChannelCredentials,
  input: ChannelSendInput,
  ctx: SendContext = {}
): Promise<ChannelSendResult> {
  const key = `${channel}:${provider}`;
  switch (key) {
    case 'sms:twilio':
    case 'rcs:twilio':
      return sendTwilio(channel === 'rcs', creds, input, ctx);
    case 'sms:msg91':
      return sendMsg91(creds, input);
    case 'sms:http':
    case 'rcs:http':
      return sendHttp(creds, input);
    case 'email:emailjs':
      return sendEmailJs(creds, input);
    default:
      throw new ChannelError(
        'bad_provider',
        `Unsupported provider "${provider}" for ${channel}`,
        400
      );
  }
}

// ---------- helpers ------------------------------------------------

async function request(url: string, init: RequestInit): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ChannelError('network_error', `Could not reach provider: ${msg}`);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/** E.164 with a leading + (providers want it; contacts may omit it). */
function toE164(phone: string): string {
  const d = digitsOnly(phone);
  return d ? `+${d}` : '';
}

function need(creds: ChannelCredentials, key: string): string {
  const v = creds[key];
  if (!v) throw new ChannelError('not_configured', `Missing provider setting "${key}"`, 400);
  return v;
}

// ---------- Twilio (SMS + RCS) -------------------------------------

async function sendTwilio(
  rcs: boolean,
  creds: ChannelCredentials,
  input: ChannelSendInput,
  ctx: SendContext
): Promise<ChannelSendResult> {
  const sid = need(creds, 'account_sid');
  const token = need(creds, 'auth_token');
  const sender = need(creds, 'sender');
  const e164 = toE164(input.to);
  if (!e164) throw new ChannelError('bad_recipient', 'Invalid phone number', 400);

  const form = new URLSearchParams();
  form.set('Body', input.text);

  if (/^MG/i.test(sender)) {
    // Messaging Service: RCS-first with automatic SMS fallback.
    form.set('MessagingServiceSid', sender);
    form.set('To', e164);
  } else if (rcs) {
    // Direct RCS sender id, e.g. "rcs:brand_xyz_agent" — no fallback.
    form.set('From', sender.startsWith('rcs:') ? sender : `rcs:${sender}`);
    form.set('To', `rcs:${e164}`);
  } else {
    form.set('From', sender);
    form.set('To', e164);
  }
  if (ctx.statusCallbackUrl) form.set('StatusCallback', ctx.statusCallbackUrl);

  const { status, text } = await request(
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`,
    {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    }
  );
  const json = safeJson(text) as { sid?: string; message?: string } | null;
  if (status >= 200 && status < 300 && json?.sid) {
    return { providerMessageId: json.sid };
  }
  throw new ChannelError(
    'provider_error',
    `Twilio: ${json?.message ?? `HTTP ${status}`}`,
    status === 401 ? 400 : 502
  );
}

// ---------- MSG91 (India SMS, DLT flow template) -------------------

async function sendMsg91(
  creds: ChannelCredentials,
  input: ChannelSendInput
): Promise<ChannelSendResult> {
  const authkey = need(creds, 'authkey');
  const templateId = need(creds, 'template_id');
  const variable = creds.body_variable || 'VAR1';
  const cc = digitsOnly(creds.country_code || '91');

  let mobile = digitsOnly(input.to);
  if (!mobile) throw new ChannelError('bad_recipient', 'Invalid phone number', 400);
  // Numbers saved without a country code (10 digits) get the default.
  if (mobile.length === 10) mobile = `${cc}${mobile}`;

  const { status, text } = await request('https://control.msg91.com/api/v5/flow', {
    method: 'POST',
    headers: { authkey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      template_id: templateId,
      short_url: '0',
      recipients: [{ mobiles: mobile, [variable]: input.text }],
    }),
  });
  const json = safeJson(text) as { type?: string; message?: string } | null;
  if (status >= 200 && status < 300 && json?.type === 'success') {
    return { providerMessageId: json.message ?? null };
  }
  throw new ChannelError('provider_error', `MSG91: ${json?.message ?? `HTTP ${status}`}`);
}

// ---------- Generic HTTP gateway (SMS or RCS partner) --------------

/** Reject non-https and obviously-internal hosts (basic SSRF guard). */
export function assertSafeGatewayUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ChannelError('bad_config', 'API URL is not a valid URL', 400);
  }
  const host = url.hostname.toLowerCase();
  const internal =
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === '::1' ||
    host.startsWith('[');
  if (url.protocol !== 'https:' || internal) {
    throw new ChannelError(
      'bad_config',
      'API URL must be a public https:// address',
      400
    );
  }
  return url;
}

/** Substitute {{placeholders}} with JSON-escaped values. */
export function renderBodyTemplate(
  template: string,
  values: Record<string, string>
): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) =>
    JSON.stringify(values[key] ?? '').slice(1, -1)
  );
}

function getPath(obj: unknown, path: string): string | null {
  let cur: unknown = obj;
  for (const part of path.split('.').filter(Boolean)) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' || typeof cur === 'number' ? String(cur) : null;
}

async function sendHttp(
  creds: ChannelCredentials,
  input: ChannelSendInput
): Promise<ChannelSendResult> {
  const url = assertSafeGatewayUrl(need(creds, 'url'));
  const e164 = toE164(input.to);
  if (!e164) throw new ChannelError('bad_recipient', 'Invalid phone number', 400);

  const body = renderBodyTemplate(need(creds, 'body_template'), {
    to: e164,
    to_digits: digitsOnly(e164),
    from: creds.sender ?? '',
    text: input.text,
  });
  if (safeJson(body) === null) {
    throw new ChannelError('bad_config', 'Body template did not render to valid JSON', 400);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (creds.auth_header_name && creds.auth_header_value) {
    headers[creds.auth_header_name] = creds.auth_header_value;
  }

  const { status, text } = await request(url.toString(), {
    method: 'POST',
    headers,
    body,
    redirect: 'error',
  });
  if (status < 200 || status >= 300) {
    throw new ChannelError(
      'provider_error',
      `Gateway returned HTTP ${status}: ${text.slice(0, 200)}`
    );
  }
  const id = creds.message_id_path ? getPath(safeJson(text), creds.message_id_path) : null;
  return { providerMessageId: id };
}

// ---------- EmailJS -------------------------------------------------

async function sendEmailJs(
  creds: ChannelCredentials,
  input: ChannelSendInput
): Promise<ChannelSendResult> {
  const { status, text } = await request('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: need(creds, 'service_id'),
      template_id: need(creds, 'template_id'),
      user_id: need(creds, 'public_key'),
      accessToken: need(creds, 'private_key'),
      // Variables your EmailJS template can use. Set the template's
      // "To Email" field to {{to_email}}.
      template_params: {
        to_email: input.to,
        to_name: input.recipientName || input.to,
        subject: input.subject || '(no subject)',
        message: input.text,
        from_name: creds.from_name || '',
        reply_to: creds.reply_to || '',
      },
    }),
  });
  if (status >= 200 && status < 300) return { providerMessageId: null };
  throw new ChannelError(
    'provider_error',
    `EmailJS: ${text.trim().slice(0, 200) || `HTTP ${status}`}`,
    status === 401 || status === 403 ? 400 : 502
  );
}
