// ============================================================
// Multichannel (SMS / RCS / Email) shared types + provider catalogue.
//
// This module is pure (no I/O, no env) so the settings UI and the
// server routes share one definition of "what fields does provider X
// need" — the UI renders the form from PROVIDER_FIELDS and the server
// validates against the same list.
// ============================================================

export const EXTRA_CHANNELS = ['sms', 'rcs', 'email'] as const;
export type ExtraChannel = (typeof EXTRA_CHANNELS)[number];
export type MessageChannel = 'whatsapp' | ExtraChannel;

export function isExtraChannel(value: unknown): value is ExtraChannel {
  return (
    typeof value === 'string' &&
    (EXTRA_CHANNELS as readonly string[]).includes(value)
  );
}

export const CHANNEL_LABEL: Record<MessageChannel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  rcs: 'RCS',
  email: 'Email',
};

export interface ProviderMeta {
  id: string;
  label: string;
  /** One-line setup hint shown under the provider picker. */
  hint: string;
}

export const PROVIDERS: Record<ExtraChannel, ProviderMeta[]> = {
  sms: [
    {
      id: 'twilio',
      label: 'Twilio',
      hint: 'Global SMS. Sender can be a Twilio number or a Messaging Service SID (MG…).',
    },
    {
      id: 'msg91',
      label: 'MSG91 (India, DLT)',
      hint: 'India SMS via a DLT-approved Flow template that has one variable for the message body.',
    },
    {
      id: 'http',
      label: 'Custom HTTP gateway',
      hint: 'Any SMS gateway with a JSON POST API. You provide the URL, auth header and body template.',
    },
  ],
  rcs: [
    {
      id: 'twilio',
      label: 'Twilio RCS',
      hint: 'Uses a Twilio RCS sender. Pass a Messaging Service SID (MG…) to get automatic SMS fallback.',
    },
    {
      id: 'http',
      label: 'Custom HTTP gateway (RBM partner)',
      hint: 'Any RCS Business Messaging partner with a JSON POST API (Route Mobile, Gupshup, Kaleyra, …).',
    },
  ],
  email: [
    {
      id: 'emailjs',
      label: 'EmailJS',
      hint: 'Sends through your EmailJS service + template. Outbound only — EmailJS cannot receive replies.',
    },
  ],
};

export interface FieldDef {
  key: string;
  label: string;
  /** Stored encrypted and never sent back to the browser. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
}

const HTTP_FIELDS: FieldDef[] = [
  {
    key: 'url',
    label: 'API URL',
    required: true,
    placeholder: 'https://api.your-gateway.com/v1/messages',
  },
  {
    key: 'auth_header_name',
    label: 'Auth header name',
    placeholder: 'Authorization',
    help: 'Leave blank if the gateway authenticates inside the body.',
  },
  {
    key: 'auth_header_value',
    label: 'Auth header value',
    secret: true,
    placeholder: 'Bearer sk_live_…',
  },
  {
    key: 'sender',
    label: 'Sender / agent ID',
    help: 'Available in the body template as {{from}}.',
  },
  {
    key: 'body_template',
    label: 'JSON body template',
    required: true,
    multiline: true,
    placeholder: '{"from":"{{from}}","to":"{{to}}","text":"{{text}}"}',
    help: 'Placeholders: {{to}} (digits with +), {{to_digits}}, {{from}}, {{text}}. Values are JSON-escaped for you.',
  },
  {
    key: 'message_id_path',
    label: 'Response message-id path',
    placeholder: 'data.message_id',
    help: 'Dot path to the provider message id in the JSON response (optional).',
  },
];

export const PROVIDER_FIELDS: Record<string, FieldDef[]> = {
  'sms:twilio': [
    { key: 'account_sid', label: 'Account SID', required: true, placeholder: 'AC…' },
    { key: 'auth_token', label: 'Auth token', required: true, secret: true },
    {
      key: 'sender',
      label: 'From number or Messaging Service SID',
      required: true,
      placeholder: '+14155550123 or MG…',
    },
  ],
  'sms:msg91': [
    { key: 'authkey', label: 'Auth key', required: true, secret: true },
    { key: 'template_id', label: 'Flow template ID', required: true },
    {
      key: 'body_variable',
      label: 'Template variable name',
      placeholder: 'VAR1',
      help: 'The ##variable## in your DLT template that receives the message text. Defaults to VAR1.',
    },
    {
      key: 'country_code',
      label: 'Default country code',
      placeholder: '91',
      help: 'Prepended to numbers saved without one. Defaults to 91.',
    },
  ],
  'sms:http': HTTP_FIELDS,
  'rcs:twilio': [
    { key: 'account_sid', label: 'Account SID', required: true, placeholder: 'AC…' },
    { key: 'auth_token', label: 'Auth token', required: true, secret: true },
    {
      key: 'sender',
      label: 'Messaging Service SID or RCS sender ID',
      required: true,
      placeholder: 'MG… or rcs:brand_xyz_agent',
      help: 'With an MG… Messaging Service, Twilio falls back to SMS when the device has no RCS.',
    },
  ],
  'rcs:http': HTTP_FIELDS,
  'email:emailjs': [
    { key: 'service_id', label: 'Service ID', required: true, placeholder: 'service_xxxxx' },
    { key: 'template_id', label: 'Template ID', required: true, placeholder: 'template_xxxxx' },
    { key: 'public_key', label: 'Public key', required: true },
    { key: 'private_key', label: 'Private key (access token)', required: true, secret: true },
    {
      key: 'from_name',
      label: 'From name',
      placeholder: 'Acme Support',
      help: 'Sent to the template as {{from_name}}.',
    },
    {
      key: 'reply_to',
      label: 'Reply-to address',
      placeholder: 'support@acme.com',
      help: 'Sent as {{reply_to}}. Replies go to this mailbox, not the CRM.',
    },
  ],
};

export function providerFields(channel: ExtraChannel, provider: string): FieldDef[] | null {
  return PROVIDER_FIELDS[`${channel}:${provider}`] ?? null;
}

export function isValidProvider(channel: ExtraChannel, provider: string): boolean {
  return PROVIDERS[channel].some((p) => p.id === provider);
}

/** Per-channel hard limits applied before a send. */
export const CHANNEL_LIMITS: Record<ExtraChannel, { maxChars: number }> = {
  sms: { maxChars: 1600 },
  rcs: { maxChars: 3072 },
  email: { maxChars: 20000 },
};

/** What a provider adapter needs and returns. */
export interface ChannelSendInput {
  /** E.164-ish phone (with +) for sms/rcs, email address for email. */
  to: string;
  text: string;
  subject?: string | null;
  recipientName?: string | null;
}

export interface ChannelSendResult {
  /** Provider's id for the message; used to match status callbacks. */
  providerMessageId: string | null;
}

/** Resolved (decrypted) provider config handed to adapters. */
export type ChannelCredentials = Record<string, string>;

export class ChannelError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 502) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    this.status = status;
  }
}
