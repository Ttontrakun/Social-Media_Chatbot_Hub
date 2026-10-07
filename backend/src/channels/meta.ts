import { Channel } from "../generated/prisma/client";
import { verifyMetaSignature } from "../crypto";
import { ChannelAdapter, ChannelSecrets, InboundMessage, SendResult, postJson } from "./types";

const GRAPH = process.env.META_GRAPH_URL || "https://graph.facebook.com/v21.0";

interface MetaBody {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: Array<{
      sender?: { id?: string };
      recipient?: { id?: string };
      timestamp?: number;
      message?: { mid?: string; text?: string; is_echo?: boolean };
    }>;
  }>;
}

/** Messenger และ Instagram Direct ใช้ payload แบบเดียวกัน ต่างแค่ object */
function makeAdapter(channel: Channel, objectName: string): ChannelAdapter {
  return {
    channel,

    verify(raw, headers, secrets) {
      const sig = headers["x-hub-signature-256"];
      const secret = secrets.appSecret;
      if (!secret) return false;
      return verifyMetaSignature(raw, secret, Array.isArray(sig) ? sig[0] : sig);
    },

    parse(body) {
      const b = body as MetaBody;
      if (b.object && b.object !== objectName) return [];
      const out: InboundMessage[] = [];
      for (const entry of b.entry || []) {
        for (const m of entry.messaging || []) {
          // is_echo = ข้อความที่เพจส่งออกเอง ไม่ต้องประมวลผลซ้ำ
          if (!m.message || m.message.is_echo) continue;
          const text = m.message.text;
          const sender = m.sender?.id;
          const pageId = m.recipient?.id || entry.id;
          if (!text || !sender || !pageId) continue;
          out.push({
            channel,
            accountExternalId: pageId,
            contactExternalId: sender,
            text,
            externalMessageId: m.message.mid,
            timestamp: m.timestamp ? new Date(m.timestamp) : new Date(),
          });
        }
      }
      return out;
    },

    async send(secrets: ChannelSecrets, to: string, text: string): Promise<SendResult> {
      const token = secrets.pageAccessToken;
      if (!token) return { ok: false, error: "ไม่พบ page access token" };
      const r = await postJson(
        `${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`,
        { recipient: { id: to }, messaging_type: "RESPONSE", message: { text: text.slice(0, 2000) } },
        {}
      );
      if (!r.ok) {
        const detail = r.json?.error?.message || r.text.slice(0, 200);
        return { ok: false, error: `${channel} ${r.status}: ${detail}` };
      }
      return { ok: true, externalId: r.json?.message_id };
    },
  };
}

export const facebookAdapter = makeAdapter(Channel.FACEBOOK, "page");
export const instagramAdapter = makeAdapter(Channel.INSTAGRAM, "instagram");

export async function fetchMetaProfile(token: string, userId: string): Promise<string | null> {
  try {
    const res = await fetch(`${GRAPH}/${userId}?fields=name&access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { name?: string; username?: string };
    return json.name || json.username || null;
  } catch {
    return null;
  }
}
