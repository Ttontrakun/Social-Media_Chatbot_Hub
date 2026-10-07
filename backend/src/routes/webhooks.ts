import { Router, raw } from "express";
import { Channel } from "../generated/prisma/client";
import { prisma, logEvent } from "../db";
import { decryptJson } from "../crypto";
import { adapters, slugToChannel } from "../channels";
import { handleInbound } from "../service/inbox";
import { xCrcResponse } from "../channels/x";
import { broadcast } from "../realtime";

export const webhooksRouter = Router();

/** Meta ยืนยัน webhook ด้วย GET hub.challenge */
webhooksRouter.get("/:slug", async (req, res) => {
  const slug = req.params.slug;
  const channel = slugToChannel[slug];
  if (!channel) {
    res.status(404).send("unknown channel");
    return;
  }

  if (channel === Channel.FACEBOOK || channel === Channel.INSTAGRAM) {
    const verifyToken = process.env.META_VERIFY_TOKEN || "";
    if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === verifyToken && verifyToken) {
      res.status(200).send(String(req.query["hub.challenge"] || ""));
      return;
    }
    res.status(403).send("verify token ไม่ถูกต้อง");
    return;
  }

  // X: ตอบ CRC challenge ด้วย consumer secret ของ connection ใด connection หนึ่ง
  if (channel === Channel.X && req.query.crc_token) {
    const conn = await prisma.connection.findFirst({ where: { channel: Channel.X } });
    const secrets = decryptJson<Record<string, string>>(conn?.secrets ?? null);
    if (!secrets?.consumerSecret) {
      res.status(400).send("ยังไม่ได้เชื่อมต่อ X");
      return;
    }
    res.json(xCrcResponse(String(req.query.crc_token), secrets.consumerSecret));
    return;
  }

  res.status(200).send("ok");
});

/**
 * รับข้อความเข้า
 * ต้องใช้ raw body เพื่อตรวจลายเซ็น — express.json() จึงถูกข้ามสำหรับ path นี้
 */
webhooksRouter.post("/:slug", raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const channel = slugToChannel[req.params.slug];
  if (!channel) {
    res.status(404).json({ error: "unknown channel" });
    return;
  }

  const rawBody: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8") || "{}");
  } catch {
    res.status(400).json({ error: "payload ไม่ใช่ JSON" });
    return;
  }

  const adapter = adapters[channel];
  const messages = adapter.parse(parsed);

  // ตอบ 200 ทันที แล้วค่อยประมวลผลเบื้องหลัง
  // แพลตฟอร์มจะส่งซ้ำถ้าเราตอบช้า
  res.status(200).json({ ok: true });

  if (!messages.length) return;

  // ข้อความชุดหนึ่งอาจมาจากหลายบัญชี จึงตรวจลายเซ็นแยกตาม connection
  const byAccount = new Map<string, typeof messages>();
  for (const m of messages) {
    const list = byAccount.get(m.accountExternalId) || [];
    list.push(m);
    byAccount.set(m.accountExternalId, list);
  }

  for (const [accountId, list] of byAccount) {
    const conn = await prisma.connection.findUnique({
      where: { channel_externalId: { channel, externalId: accountId } },
    });
    if (!conn) continue;

    const secrets = decryptJson<Record<string, string>>(conn.secrets) || {};
    if (!adapter.verify(rawBody, req.headers, secrets)) {
      await logEvent(conn.workspaceId, "webhook.rejected", `${channel}: ลายเซ็นไม่ถูกต้อง`);
      continue;
    }

    for (const msg of list) {
      try {
        await handleInbound(msg);
      } catch (err) {
        await logEvent(conn.workspaceId, "webhook.error", err instanceof Error ? err.message.slice(0, 200) : "error");
      }
    }
    broadcast(conn.workspaceId, "refresh", { reason: "webhook" });
  }
});
