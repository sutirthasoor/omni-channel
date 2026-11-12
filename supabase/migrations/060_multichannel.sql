-- ============================================================
-- 060_multichannel.sql
--
-- Adds SMS, RCS and Email (EmailJS) next to WhatsApp WITHOUT touching
-- any WhatsApp table semantics:
--
--   * messages.channel      — which channel carried the message
--                             ('whatsapp' for every pre-existing row).
--   * messages.subject      — email subject (NULL for other channels).
--   * conversations.last_channel — channel of the most recent message,
--                             used by the inbox to pre-select a channel.
--   * channel_configs       — one row per (account, channel) holding the
--                             provider choice, non-secret settings and
--                             AES-GCM encrypted secrets.
--
-- Conversations stay one-per-(account, contact): SMS / RCS / email
-- messages land in the same thread as the contact's WhatsApp chat.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_channel_check;
ALTER TABLE messages
  ADD CONSTRAINT messages_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'rcs', 'email'));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS subject TEXT;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS last_channel TEXT NOT NULL DEFAULT 'whatsapp';

ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_last_channel_check;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_last_channel_check
  CHECK (last_channel IN ('whatsapp', 'sms', 'rcs', 'email'));

-- Status callbacks look a message up by the provider's id (Twilio SID,
-- MSG91 request id, ...). `message_id` already holds Meta's wamid for
-- WhatsApp, so scope the lookup by channel.
CREATE INDEX IF NOT EXISTS idx_messages_channel_message_id
  ON messages (channel, message_id)
  WHERE channel <> 'whatsapp';

-- ------------------------------------------------------------
-- channel_configs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channel_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('sms', 'rcs', 'email')),
  provider TEXT NOT NULL,
  -- Non-secret settings (sender id, template id, ...). Safe to show.
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- AES-256-GCM encrypted JSON blob of secret settings (tokens, keys).
  secrets_encrypted TEXT,
  -- Random token embedded in the inbound-webhook URL. Authenticates
  -- provider callbacks and identifies the account.
  inbound_token TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  status TEXT NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'disconnected')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, channel),
  UNIQUE (inbound_token)
);

CREATE INDEX IF NOT EXISTS idx_channel_configs_account
  ON channel_configs (account_id);

ALTER TABLE channel_configs ENABLE ROW LEVEL SECURITY;

-- Admins manage channel settings (same rule as whatsapp_config).
-- Agents never read this table directly: the server routes use the
-- service-role client, scoped by account_id, to send on their behalf —
-- so secrets are never exposed to non-admin browsers.
DROP POLICY IF EXISTS channel_configs_select ON channel_configs;
DROP POLICY IF EXISTS channel_configs_insert ON channel_configs;
DROP POLICY IF EXISTS channel_configs_update ON channel_configs;
DROP POLICY IF EXISTS channel_configs_delete ON channel_configs;
CREATE POLICY channel_configs_select ON channel_configs FOR SELECT
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY channel_configs_insert ON channel_configs FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY channel_configs_update ON channel_configs FOR UPDATE
  USING (is_account_member(account_id, 'admin'));
CREATE POLICY channel_configs_delete ON channel_configs FOR DELETE
  USING (is_account_member(account_id, 'admin'));
