-- Track SMS / RCS / Email campaigns in the Broadcasts table + analytics.
ALTER TABLE broadcasts ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE broadcasts DROP CONSTRAINT IF EXISTS broadcasts_channel_check;
ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_channel_check
  CHECK (channel IN ('whatsapp', 'sms', 'rcs', 'email'));

-- Atomic counter bump for batched channel campaigns.
CREATE OR REPLACE FUNCTION bump_channel_broadcast(
  p_id UUID, p_account_id UUID, p_total INT, p_sent INT, p_failed INT
) RETURNS VOID LANGUAGE sql AS $$
  UPDATE broadcasts SET
    total_recipients = COALESCE(total_recipients,0) + p_total,
    sent_count       = COALESCE(sent_count,0) + p_sent,
    delivered_count  = COALESCE(delivered_count,0) + p_sent,
    failed_count     = COALESCE(failed_count,0) + p_failed,
    updated_at = NOW()
  WHERE id = p_id AND account_id = p_account_id AND channel <> 'whatsapp';
$$;
