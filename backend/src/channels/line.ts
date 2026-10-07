import { Channel } from "../generated/prisma/client";
import { verifyLineSignature } from "../crypto";
import { ChannelAdapter, ChannelSecrets, InboundMessage, SendResult, postJson } from "./types";

const API = "https://api.line.me/v2/bot";

interface LineBody {
  destination?: string;
  events?: Array<{
    type: string;
    replyToken?: string;
    timestamp?: number;
    source?: { userId?: string; type?: string };
    message?: { id?: string; type?: string; text?: string };
  }>;
}

export const lineAdapter: ChannelAdapter = {
  channel: Channel.LINE,

  verify(raw, headers, secrets) {
    const sig = headers["x-line-signature"];
    const secret = secrets.channelSecret;
    if (!secret) return false;
    return verifyLineSignature(raw, secret, Array.isArray(sig) ? sig[0] : sig);
  },

  parse(body) {
    const b = body as LineBody;
    const out: InboundMessage[] = [];
    for (const ev of b.events || []) {
      if (ev.type !== "message" || ev.message?.type !== "text") continue;
      const userId = ev.source?.userId;
      if (!userId || !b.destination) continue;
      out.push({
        channel: Channel.LINE,
        accountExternalId: b.destination,
        contactExternalId: userId,
        text: ev.message.text || "",
        externalMessageId: ev.message.id,
        timestamp: ev.timestamp ? new Date(ev.timestamp) : new Date(),
        replyToken: ev.replyToken,
      });
    }
    return out;
  },

  async send(secrets, to, text, opts): Promise<SendResult> {
    const token = secrets.accessToken;
    if (!token) return { ok: false, error: "ไม่พบ channel access token" };
    const headers = { authorization: `Bearer ${token}` };
    const messages = [{ type: "text", text: text.slice(0, 5000) }];

    // reply ใช้ได้ครั้งเดียวและมีอายุสั้น ถ้าหมดอายุค่อยเปลี่ยนไปใช้ push (มีโควตา)
    if (opts?.replyToken) {
      const r = await postJson(`${API}/message/reply`, { replyToken: opts.replyToken, messages }, headers);
      if (r.ok) return { ok: true };
    }
    const r = await postJson(`${API}/message/push`, { to, messages }, headers);
    if (!r.ok) return { ok: false, error: `LINE ${r.status}: ${r.text.slice(0, 200)}` };
    return { ok: true };
  },
};

/** ดึงชื่อโปรไฟล์ลูกค้า (ไม่บังคับ — ถ้าพลาดใช้ชื่อสำรอง) */
export async function fetchLineProfile(accessToken: string, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${API}/profile/${userId}`, {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { displayName?: string };
    return json.displayName || null;
  } catch {
    return null;
  }
}
