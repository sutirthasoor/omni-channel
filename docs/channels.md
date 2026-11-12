# SMS, RCS and Email channels

WhatsApp stays exactly as it was. This adds three more channels that live
in the **same conversation thread per contact**:

| Channel | Providers | Inbound replies | Delivery receipts |
| ------- | --------- | --------------- | ----------------- |
| SMS     | Twilio, MSG91 (India/DLT), custom HTTP gateway | Twilio, custom gateway | Twilio, custom gateway |
| RCS     | Twilio RCS, custom HTTP gateway (any RBM partner) | Twilio, custom gateway | Twilio, custom gateway |
| Email   | EmailJS (send) + any inbound-parse service (receive) | Yes, via the webhook URL | No |

## Setup

1. Apply `supabase/migrations/060_multichannel.sql` and `061_channel_broadcasts.sql`.
2. Make sure `NEXT_PUBLIC_SITE_URL` is set to your public URL (used for
   Twilio status callbacks). `ENCRYPTION_KEY` is reused to encrypt provider secrets.
3. As an admin open **Settings → SMS, RCS & Email**, pick a provider, fill in
   the credentials, **Connect**, then **Send test**.
4. For SMS/RCS replies and delivery receipts, paste the webhook URL shown on
   the card into your provider (inbound-message webhook **and** status callback).
   The token in the URL is the secret; regenerate by disconnecting and reconnecting.

### EmailJS

- Template: **To Email** = `{{to_email}}`, **Subject** = `{{subject}}`, body contains `{{message}}`.
  Also available: `{{to_name}}`, `{{from_name}}`, `{{reply_to}}`.
- EmailJS → Account → Security: allow API calls from non-browser applications.
- Rate limit is 1 email/second; campaigns are paced automatically.

### Twilio RCS

Use your Messaging Service SID (`MG…`) as the sender to get RCS-first delivery
with automatic SMS fallback, or an RCS sender id (`brand_xxx_agent`) for RCS only.

### Custom HTTP gateway (SMS / RCS partners)

Provide the HTTPS URL, an optional auth header, and a JSON body template using
`{{to}}`, `{{to_digits}}`, `{{from}}`, `{{text}}`. For inbound messages and
receipts have the gateway POST JSON to the webhook URL:

```json
{ "from": "+919876543210", "text": "Hello", "id": "provider-msg-id" }
{ "id": "provider-msg-id", "status": "delivered" }
```

## Using it

- **Inbox:** once any channel is connected a "Reply via" strip appears above the
  composer (WhatsApp is the default). Messages show a channel badge.
- **Campaigns:** Broadcasts → **SMS / RCS / Email** sends to all contacts or a tag,
  with `{{name}}` personalisation. (The WhatsApp template wizard is unchanged.)

## Behaviour

Inbound SMS / RCS / Email replies run through the same pipeline as WhatsApp:
Flows, Automations and AI auto-reply. Campaign sends are recorded in the
Broadcasts table and included in analytics. Webhook requests are authenticated
by the secret URL token, not by provider signatures. Email campaigns are paced
at one send per ~1.1s to respect EmailJS's rate limit.
