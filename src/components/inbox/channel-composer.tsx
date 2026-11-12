"use client";

import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Loader2, Send } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useCan } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import {
  confirmedSendUpdate,
  newTempMessageId,
} from "@/lib/inbox/optimistic-messages";
import {
  CHANNEL_LABEL,
  CHANNEL_LIMITS,
  isExtraChannel,
  type ExtraChannel,
  type MessageChannel,
} from "@/lib/channels/types";
import type { Message } from "@/types";

// ------------------------------------------------------------
// Which extra channels the account has connected. One fetch per
// mount; the list is tiny and changes rarely (Settings → Channels).
// ------------------------------------------------------------
export function useConnectedChannels(): ExtraChannel[] {
  const [channels, setChannels] = useState<ExtraChannel[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels/config")
      .then((r) => (r.ok ? r.json() : { channels: [] }))
      .then((json: { channels?: { channel: string; status: string }[] }) => {
        if (cancelled) return;
        setChannels(
          (json.channels ?? [])
            .filter((c) => c.status === "connected" && isExtraChannel(c.channel))
            .map((c) => c.channel as ExtraChannel),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return channels;
}

// ------------------------------------------------------------
// Channel switcher — a thin tab strip above the composer.
// ------------------------------------------------------------
export function ChannelSwitcher({
  value,
  onChange,
  available,
}: {
  value: MessageChannel;
  onChange: (c: MessageChannel) => void;
  available: ExtraChannel[];
}) {
  const all: MessageChannel[] = ["whatsapp", ...available];
  return (
    <div className="flex items-center gap-1 border-t bg-background px-3 pt-2" role="tablist">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        Reply via
      </span>
      {all.map((c) => (
        <button
          key={c}
          type="button"
          role="tab"
          aria-selected={value === c}
          onClick={() => onChange(c)}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
            value === c
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground",
          )}
        >
          {CHANNEL_LABEL[c]}
        </button>
      ))}
    </div>
  );
}

/** Rough SMS segment count (GSM-7 = 160/153, otherwise UCS-2 = 70/67). */
function smsSegments(text: string): number {
  if (!text) return 0;
  // eslint-disable-next-line no-control-regex
  const gsm = /^[\x00-\x7F€£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ]*$/.test(text);
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

// ------------------------------------------------------------
// Composer for SMS / RCS / Email. Same optimistic-send pattern as
// the WhatsApp composer; the WhatsApp composer itself is untouched.
// ------------------------------------------------------------
export function ChannelComposer({
  conversationId,
  channel,
  contactPhone,
  contactEmail,
  onNewMessage,
  onUpdateMessage,
}: {
  conversationId: string;
  channel: ExtraChannel;
  contactPhone?: string | null;
  contactEmail?: string | null;
  onNewMessage: (m: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
}) {
  const canSend = useCan("send-messages");
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [sending, setSending] = useState(false);

  // Drafts don't carry across channels or conversations.
  useEffect(() => {
    setText("");
    setSubject("");
  }, [conversationId, channel]);

  const max = CHANNEL_LIMITS[channel].maxChars;
  const missingAddress =
    channel === "email" ? !contactEmail?.trim() : !contactPhone?.trim();

  const send = useCallback(async () => {
    const body = text.trim();
    if (!body || sending || !canSend || missingAddress) return;
    setSending(true);
    const tempId = newTempMessageId();
    onNewMessage({
      id: tempId,
      conversation_id: conversationId,
      sender_type: "agent",
      content_type: "text",
      content_text: body,
      status: "sending",
      created_at: new Date().toISOString(),
      channel,
      subject: channel === "email" ? subject.trim() || "(no subject)" : null,
    });
    setText("");
    try {
      const res = await fetch("/api/channels/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: conversationId,
          channel,
          content_text: body,
          subject: channel === "email" ? subject : undefined,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload?.error || `Send failed (HTTP ${res.status})`);
        onUpdateMessage(tempId, { status: "failed" });
        return;
      }
      onUpdateMessage(tempId, confirmedSendUpdate(payload));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
      onUpdateMessage(tempId, { status: "failed" });
    } finally {
      setSending(false);
    }
  }, [
    text,
    subject,
    sending,
    canSend,
    missingAddress,
    channel,
    conversationId,
    onNewMessage,
    onUpdateMessage,
  ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="space-y-2 border-t-0 bg-background px-3 pb-3 pt-2">
      {missingAddress && (
        <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
          This contact has no {channel === "email" ? "email address" : "phone number"} saved.
          Add one in the contact panel to reply by {CHANNEL_LABEL[channel]}.
        </p>
      )}
      {channel === "email" && (
        <Input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          maxLength={300}
          disabled={!canSend || missingAddress}
        />
      )}
      <div className="flex items-end gap-2">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={channel === "email" ? 4 : 2}
          maxLength={max}
          disabled={!canSend || missingAddress}
          placeholder={`Write a ${CHANNEL_LABEL[channel]} message…`}
          className="min-h-0 resize-none"
        />
        <Button
          onClick={() => void send()}
          disabled={!text.trim() || sending || !canSend || missingAddress}
          aria-label={`Send ${CHANNEL_LABEL[channel]} message`}
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </Button>
      </div>
      <p className="text-right text-[11px] text-muted-foreground">
        {channel === "sms"
          ? `${text.length} chars · ${smsSegments(text)} SMS segment${smsSegments(text) === 1 ? "" : "s"}`
          : `${text.length}/${max}`}
        {channel === "rcs" && " · falls back to SMS if the device has no RCS (Twilio Messaging Service)"}
      </p>
    </div>
  );
}
