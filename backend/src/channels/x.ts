import crypto from "crypto";
import { Channel } from "../generated/prisma/client";
import { timingSafeEqual } from "../crypto";
import { ChannelAdapter, ChannelSecrets, InboundMessage, SendResult, postJson } from "./types";

const API = process.env.X_API_URL || "https://api.twitter.com/2";

/**
 * หมายเหตุสำคัญเรื่อง X
 * การรับ DM แบบ realtime ต้องใช้ Account Activity API ซึ่งเปิดให้เฉพาะแพ็กเกจระดับสูง
 * อะแดปเตอร์นี้จึงรองรับ payload ของ Account Activity (direct_message_events)
 * ถ้าแพ็กเกจที่ใช้ไม่มี webhook ต้องเปลี่ยนไปใช้วิธี polling แทน (ยังไม่ได้ทำในเวอร์ชันนี้)
 */
interface XBody {
  for_user_id?: string;
  direct_message_events?: Array<{
    id?: string;
    created_timestamp?: string;
    message_create?: {
      sender_id?: string;
      target?: { recipient_id?: string };
      message_data?: { text?: string };
    };
  }>;
  users?: Record<string, { id?: string; name?: string; screen_name?: string }>;
}

export const xAdapter: ChannelAdapter = {
  channel: Channel.X,

  verify(raw, headers, secrets) {
    const sig = headers["x-twitter-webhooks-signature"];
    const secret = secrets.consumerSecret;
    if (!secret) return false;
    const header = Array.isArray(sig) ? sig[0] : sig;
    if (!header || !header.startsWith("sha256=")) return false;
    const expected = "sha256=" + crypto.createHmac("sha256", secret).update(raw).digest("base64");
    return timingSafeEqual(expected, header);
  },

  parse(body) {
    const b = body as XBody;
    const out: InboundMessage[] = [];
    for (const ev of b.direct_message_events || []) {
      const mc = ev.message_create;
      const sender = mc?.sender_id;
      const recipient = mc?.target?.recipient_id || b.for_user_id;
      const text = mc?.message_data?.text;
      if (!sender || !recipient || !text) continue;
      // ข้ามข้อความที่เราส่งออกเอง
      if (sender === b.for_user_id) continue;
      out.push({
        channel: Channel.X,
        accountExternalId: recipient,
        contactExternalId: sender,
        contactName: b.users?.[sender]?.name || (b.users?.[sender]?.screen_name ? "@" + b.users[sender].screen_name : undefined),
        text,
        externalMessageId: ev.id,
        timestamp: ev.created_timestamp ? new Date(Number(ev.created_timestamp)) : new Date(),
      });
    }
    return out;
  },

  async send(secrets: ChannelSecrets, to: string, text: string): Promise<SendResult> {
    const token = secrets.accessToken;
    if (!token) return { ok: false, error: "ไม่พบ access token ของ X" };
    const r = await postJson(
      `${API}/dm_conversations/with/${encodeURIComponent(to)}/messages`,
      { text: text.slice(0, 10000) },
      { authorization: `Bearer ${token}` }
    );
    if (!r.ok) {
      const detail = r.json?.detail || r.json?.title || r.text.slice(0, 200);
      return { ok: false, error: `X ${r.status}: ${detail}` };
    }
    return { ok: true, externalId: r.json?.data?.dm_event_id };
  },
};

/** X ขอให้ตอบ CRC challenge เพื่อยืนยันว่าเราถือ consumer secret จริง */
export function xCrcResponse(crcToken: string, consumerSecret: string): { response_token: string } {
  const hmac = crypto.createHmac("sha256", consumerSecret).update(crcToken).digest("base64");
  return { response_token: `sha256=${hmac}` };
}
