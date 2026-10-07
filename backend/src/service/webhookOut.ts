import crypto from "crypto";
import { prisma, logEvent } from "../db";

/** ส่งเหตุการณ์ออกไปให้ระบบภายนอกที่ผู้ใช้ตั้ง webhook ไว้ */
export async function notifyOutbound(workspaceId: string, payload: Record<string, unknown>): Promise<void> {
  const keys = await prisma.apiKey.findMany({ where: { workspaceId, webhookOn: true, NOT: { webhookUrl: null } } });
  for (const k of keys) {
    if (!k.webhookUrl) continue;
    const body = JSON.stringify({ event: "message.sent", at: new Date().toISOString(), ...payload });
    const signature = "sha256=" + crypto.createHmac("sha256", k.keyHash).update(body).digest("hex");
    try {
      const res = await fetch(k.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature },
        body,
        signal: AbortSignal.timeout(10000),
      });
      await logEvent(workspaceId, "webhook.out", `POST ${k.webhookUrl} → ${res.status}`);
    } catch (err) {
      await logEvent(workspaceId, "webhook.failed", `POST ${k.webhookUrl} → ${err instanceof Error ? err.message : "error"}`);
    }
  }
}
