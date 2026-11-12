"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, Loader2, Mail, MessageSquare, Smartphone } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  CHANNEL_LABEL,
  EXTRA_CHANNELS,
  PROVIDERS,
  providerFields,
  type ExtraChannel,
} from "@/lib/channels/types";
import { SettingsPanelHead } from "./settings-panel-head";

interface Summary {
  channel: ExtraChannel;
  provider: string;
  status: "connected" | "disconnected";
  settings: Record<string, string>;
  secretsSet: string[];
  inboundToken: string;
}

const ICONS = { sms: MessageSquare, rcs: Smartphone, email: Mail } as const;

const DESCRIPTIONS: Record<ExtraChannel, string> = {
  sms: "Text any contact with a phone number from the inbox or a campaign.",
  rcs: "Rich messaging on Android. Falls back to SMS when you use a Twilio Messaging Service.",
  email: "Send email to contacts through your EmailJS account.",
};

export function ChannelsConfig() {
  const { canEditSettings, profileLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saved, setSaved] = useState<Partial<Record<ExtraChannel, Summary>>>({});

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels/config");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      const next: Partial<Record<ExtraChannel, Summary>> = {};
      for (const c of json.channels as Summary[]) next[c.channel] = c;
      setSaved(next);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load channels");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || profileLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead
        title="Channels"
        description="Connect SMS, RCS and Email next to WhatsApp. Every conversation stays in one thread per contact — pick the channel when you reply."
      />
      {!canEditSettings && (
        <p className="mb-4 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          Only admins can change channel settings.
        </p>
      )}
      <div className="space-y-5">
        {EXTRA_CHANNELS.map((ch) => (
          <ChannelCard
            key={ch}
            channel={ch}
            saved={saved[ch]}
            canEdit={canEditSettings}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}

function ChannelCard({
  channel,
  saved,
  canEdit,
  onChanged,
}: {
  channel: ExtraChannel;
  saved?: Summary;
  canEdit: boolean;
  onChanged: () => Promise<void>;
}) {
  const Icon = ICONS[channel];
  const providers = PROVIDERS[channel];
  const [provider, setProvider] = useState(saved?.provider ?? providers[0].id);
  const [values, setValues] = useState<Record<string, string>>(saved?.settings ?? {});
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [testTo, setTestTo] = useState("");

  // Re-sync the form when the saved row changes (after save / delete).
  useEffect(() => {
    setProvider(saved?.provider ?? providers[0].id);
    setValues(saved?.settings ?? {});
  }, [saved, providers]);

  const fields = providerFields(channel, provider) ?? [];
  const connected = saved?.status === "connected";
  const providerChanged = !!saved && saved.provider !== provider;
  const meta = providers.find((p) => p.id === provider);

  const webhookUrl =
    saved && typeof window !== "undefined"
      ? `${window.location.origin}/api/channels/webhook/${channel}/${saved.inboundToken}`
      : null;

  async function call(
    kind: "save" | "test" | "delete",
    url: string,
    init: RequestInit,
    okMsg: string
  ) {
    setBusy(kind);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json" },
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
      toast.success(okMsg);
      if (kind !== "test") await onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <Icon className="h-4 w-4" />
            {CHANNEL_LABEL[channel]}
          </CardTitle>
          <Badge variant={connected ? "default" : "secondary"}>
            {connected ? "Connected" : "Not connected"}
          </Badge>
        </div>
        <CardDescription>{DESCRIPTIONS[channel]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {providers.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor={`${channel}-provider`}>Provider</Label>
            <select
              id={`${channel}-provider`}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={provider}
              disabled={!canEdit}
              onChange={(e) => {
                setProvider(e.target.value);
                setValues({});
              }}
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>
        )}
        {meta && <p className="text-xs text-muted-foreground">{meta.hint}</p>}

        {fields.map((f) => {
          const hasSecret = f.secret && saved && !providerChanged && saved.secretsSet.includes(f.key);
          const id = `${channel}-${f.key}`;
          return (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={id}>
                {f.label}
                {f.required ? " *" : ""}
              </Label>
              {f.multiline ? (
                <Textarea
                  id={id}
                  rows={3}
                  disabled={!canEdit}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              ) : (
                <Input
                  id={id}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  disabled={!canEdit}
                  placeholder={hasSecret ? "•••••••• saved — leave blank to keep" : f.placeholder}
                  value={values[f.key] ?? ""}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                />
              )}
              {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}
            </div>
          );
        })}

        {webhookUrl && (
          <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
            <Label>Incoming-message &amp; status webhook</Label>
            <div className="flex gap-2">
              <Input readOnly value={webhookUrl} className="font-mono text-xs" />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => {
                  void navigator.clipboard.writeText(webhookUrl);
                  toast.success("Webhook URL copied");
                }}
                aria-label="Copy webhook URL"
              >
                <Copy className="h-4 w-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste this into your provider as both the inbound-message webhook and the status
              callback (HTTP POST). Keep it private — it authenticates the provider.
            </p>
          </div>
        )}
        {channel === "email" && (
          <p className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            In your EmailJS template set <b>To Email</b> to <code>{"{{to_email}}"}</code>, the
            subject to <code>{"{{subject}}"}</code> and put <code>{"{{message}}"}</code> in the
            body. In EmailJS → Account → Security, allow API calls from non-browser applications
            so the private key works from the server. To receive replies in the inbox, set your
            reply-to address to a mailbox handled by an inbound-parse service (Mailgun, SendGrid,
            Resend, Postmark, Zapier…) and point it at the webhook URL shown here.
          </p>
        )}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              disabled={busy !== null}
              onClick={() =>
                call(
                  "save",
                  "/api/channels/config",
                  { method: "PUT", body: JSON.stringify({ channel, provider, values }) },
                  `${CHANNEL_LABEL[channel]} saved`
                )
              }
            >
              {busy === "save" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {connected ? "Update" : "Connect"}
            </Button>
            {connected && (
              <>
                <Input
                  className="h-9 w-52"
                  placeholder={channel === "email" ? "test@you.com" : "+919876543210"}
                  value={testTo}
                  onChange={(e) => setTestTo(e.target.value)}
                />
                <Button
                  variant="outline"
                  disabled={busy !== null || !testTo.trim()}
                  onClick={() =>
                    call(
                      "test",
                      "/api/channels/test",
                      { method: "POST", body: JSON.stringify({ channel, to: testTo }) },
                      "Test message sent"
                    )
                  }
                >
                  {busy === "test" && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Send test
                </Button>
                <Button
                  variant="ghost"
                  className="text-destructive"
                  disabled={busy !== null}
                  onClick={() => {
                    if (!window.confirm(`Disconnect ${CHANNEL_LABEL[channel]}?`)) return;
                    void call(
                      "delete",
                      `/api/channels/config?channel=${channel}`,
                      { method: "DELETE" },
                      `${CHANNEL_LABEL[channel]} disconnected`
                    );
                  }}
                >
                  Disconnect
                </Button>
              </>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
