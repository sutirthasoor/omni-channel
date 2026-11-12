"use client";

import { useEffect, useState } from "react";
import { Loader2, Megaphone } from "lucide-react";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConnectedChannels } from "@/components/inbox/channel-composer";
import {
  CHANNEL_LABEL,
  CHANNEL_LIMITS,
  type ExtraChannel,
} from "@/lib/channels/types";

interface TagRow {
  id: string;
  name: string;
}

interface Progress {
  sent: number;
  failed: number;
  firstErrors: string[];
}

/**
 * Bulk SMS / RCS / Email send. Separate from the WhatsApp template
 * wizard (which is untouched): pick a channel, an optional tag, write
 * the message, and the dialog drives /api/channels/bulk batch by batch.
 */
export function ChannelCampaignDialog() {
  const connected = useConnectedChannels();
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<ExtraChannel | null>(null);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [tagId, setTagId] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!channel && connected.length > 0) setChannel(connected[0]);
  }, [connected, channel]);

  useEffect(() => {
    if (!open) return;
    createClient()
      .from("tags")
      .select("id, name")
      .order("name")
      .then(({ data }) => setTags((data as TagRow[] | null) ?? []));
  }, [open]);

  if (connected.length === 0) return null;

  async function run() {
    if (!channel || !text.trim()) return;
    setRunning(true);
    setDone(false);
    const total: Progress = { sent: 0, failed: 0, firstErrors: [] };
    setProgress(total);
    let cursor: string | null = null;
    let broadcastId: string | null = null;
    try {
      // Loop batches until the server reports `done`.
      for (let guard = 0; guard < 2000; guard++) {
        const res: Response = await fetch("/api/channels/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channel,
            content_text: text,
            subject,
            tag_id: tagId || undefined,
            cursor,
            broadcast_id: broadcastId || undefined,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        broadcastId = json.broadcast_id ?? broadcastId;
        total.sent += json.sent;
        total.failed += json.failed;
        for (const f of json.failures as { contact: string; error: string }[]) {
          if (total.firstErrors.length < 5) total.firstErrors.push(`${f.contact}: ${f.error}`);
        }
        setProgress({ ...total, firstErrors: [...total.firstErrors] });
        if (json.done) break;
        cursor = json.next_cursor;
      }
      setDone(true);
      toast.success(`${CHANNEL_LABEL[channel]} campaign finished`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Campaign stopped");
    } finally {
      setRunning(false);
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Megaphone className="h-4 w-4" />
        SMS / RCS / Email
      </Button>
      <Dialog open={open} onOpenChange={(o) => !running && setOpen(o)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Send a campaign</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <div className="flex gap-2">
                {connected.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    size="sm"
                    variant={channel === c ? "default" : "outline"}
                    disabled={running}
                    onClick={() => setChannel(c)}
                  >
                    {CHANNEL_LABEL[c]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="camp-tag">Audience</Label>
              <select
                id="camp-tag"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={tagId}
                disabled={running}
                onChange={(e) => setTagId(e.target.value)}
              >
                <option value="">
                  All contacts with {channel === "email" ? "an email" : "a phone number"}
                </option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    Tag: {t.name}
                  </option>
                ))}
              </select>
            </div>

            {channel === "email" && (
              <div className="space-y-1.5">
                <Label htmlFor="camp-subject">Subject</Label>
                <Input
                  id="camp-subject"
                  value={subject}
                  disabled={running}
                  onChange={(e) => setSubject(e.target.value)}
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="camp-text">Message</Label>
              <Textarea
                id="camp-text"
                rows={5}
                value={text}
                disabled={running}
                maxLength={channel ? CHANNEL_LIMITS[channel].maxChars : undefined}
                placeholder="Hi {{name}}, …"
                onChange={(e) => setText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {"{{name}}"} becomes the contact&apos;s first name.
                {channel === "sms" &&
                  " In India, bulk SMS must match a DLT-approved template — use the same wording."}
                {channel === "email" && " EmailJS sends about one email per second."}
                {" Only message people who agreed to hear from you."}
              </p>
            </div>

            {progress && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <p>
                  {running ? "Sending… " : done ? "Done. " : ""}
                  <b>{progress.sent}</b> sent, <b>{progress.failed}</b> failed
                </p>
                {progress.firstErrors.map((e) => (
                  <p key={e} className="mt-1 text-xs text-destructive">
                    {e}
                  </p>
                ))}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={running} onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button disabled={running || !text.trim() || !channel} onClick={() => void run()}>
              {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Send campaign
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
