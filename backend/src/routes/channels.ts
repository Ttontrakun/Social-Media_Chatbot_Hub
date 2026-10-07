import { Router } from "express";
import { z } from "zod";
import { Channel, ConnectionStatus } from "../generated/prisma/client";
import { prisma, logEvent } from "../db";
import { requireAuth, requireAdmin } from "../auth";
import { encryptJson } from "../crypto";
import { env } from "../env";
import { broadcast } from "../realtime";
import { channelToSlug } from "../channels";

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const GRAPH = process.env.META_GRAPH_URL || "https://graph.facebook.com/v21.0";
const META_APP_ID = process.env.META_APP_ID || "";
const META_APP_SECRET = process.env.META_APP_SECRET || "";

function publicWebhook(channel: Channel): string {
  return `${env.publicUrl.replace(/\/$/, "")}/webhooks/${channelToSlug[channel]}`;
}

function view(c: {
  id: string;
  channel: Channel;
  externalId: string;
  accountName: string;
  status: ConnectionStatus;
  botEnabled: boolean;
  lastError: string | null;
}) {
  return {
    id: c.id,
    channel: c.channel,
    externalId: c.externalId,
    accountName: c.accountName,
    status: c.status,
    botEnabled: c.botEnabled,
    lastError: c.lastError,
    webhookUrl: publicWebhook(c.channel),
  };
}

/**
 * กันไม่ให้ workspace หนึ่งแย่งเพจที่อีก workspace เชื่อมไว้แล้ว
 * ถ้าปล่อยให้ upsert ทับได้ ข้อความของลูกค้าจะถูกส่งข้ามองค์กร
 */
async function assertNotOwnedByOthers(channel: Channel, externalId: string, workspaceId: string): Promise<string | null> {
  const existing = await prisma.connection.findUnique({ where: { channel_externalId: { channel, externalId } } });
  if (existing && existing.workspaceId !== workspaceId) {
    return `บัญชีนี้ถูกเชื่อมกับอีก workspace อยู่แล้ว ต้องตัดการเชื่อมต่อจากที่นั่นก่อน`;
  }
  return null;
}

channelsRouter.get("/", async (req, res) => {
  const rows = await prisma.connection.findMany({
    where: { workspaceId: req.user!.workspaceId },
    orderBy: { createdAt: "asc" },
  });
  res.json({
    connections: rows.map(view),
    webhookUrls: Object.fromEntries(Object.values(Channel).map((c) => [c, publicWebhook(c)])),
    metaOAuthReady: Boolean(META_APP_ID && META_APP_SECRET),
  });
});

/** เชื่อม LINE — ผู้ใช้กรอกค่าจาก LINE Developers Console เอง */
channelsRouter.post("/line", requireAdmin, async (req, res) => {
  const body = z
    .object({
      accountName: z.string().trim().max(80).optional(),
      channelId: z.string().trim().min(1, "กรอก Channel ID"),
      channelSecret: z.string().trim().min(1, "กรอก Channel secret"),
      accessToken: z.string().trim().min(1, "กรอก Channel access token"),
    })
    .parse(req.body ?? {});

  // ยืนยันว่า token ใช้ได้จริง และดึง userId ของบอท (= destination ที่ LINE ส่งมากับ webhook)
  let botUserId: string;
  let botName: string | undefined;
  try {
    const r = await fetch("https://api.line.me/v2/bot/info", {
      headers: { authorization: `Bearer ${body.accessToken}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      res.status(400).json({ error: `LINE ปฏิเสธ access token (${r.status}) — ตรวจสอบว่าคัดลอกครบถ้วน` });
      return;
    }
    const json = (await r.json()) as { userId?: string; displayName?: string };
    if (!json.userId) {
      res.status(400).json({ error: "LINE ไม่ได้ส่ง userId ของบอทกลับมา" });
      return;
    }
    botUserId = json.userId;
    botName = json.displayName;
  } catch (err) {
    res.status(502).json({ error: `ติดต่อ LINE ไม่ได้: ${err instanceof Error ? err.message : "error"}` });
    return;
  }

  const clash = await assertNotOwnedByOthers(Channel.LINE, botUserId, req.user!.workspaceId);
  if (clash) {
    res.status(409).json({ error: clash });
    return;
  }

  const conn = await prisma.connection.upsert({
    where: { channel_externalId: { channel: Channel.LINE, externalId: botUserId } },
    create: {
      workspaceId: req.user!.workspaceId,
      channel: Channel.LINE,
      externalId: botUserId,
      accountName: body.accountName || botName || "LINE OA",
      status: ConnectionStatus.CONNECTED,
      botEnabled: true,
      secrets: encryptJson({ channelId: body.channelId, channelSecret: body.channelSecret, accessToken: body.accessToken }),
    },
    update: {
      workspaceId: req.user!.workspaceId,
      accountName: body.accountName || botName || "LINE OA",
      status: ConnectionStatus.CONNECTED,
      lastError: null,
      secrets: encryptJson({ channelId: body.channelId, channelSecret: body.channelSecret, accessToken: body.accessToken }),
    },
  });

  await logEvent(req.user!.workspaceId, "channel.connected", `LINE — ${conn.accountName}`);
  broadcast(req.user!.workspaceId, "connection", view(conn));
  res.json({ connection: view(conn), webhookUrl: publicWebhook(Channel.LINE) });
});

/** เชื่อม Facebook / Instagram / X แบบกรอก token เอง (ไม่ต้องผ่าน OAuth) */
channelsRouter.post("/manual", requireAdmin, async (req, res) => {
  const body = z
    .object({
      channel: z.enum(["FACEBOOK", "INSTAGRAM", "X"]),
      externalId: z.string().trim().min(1, "กรอก ID ของเพจหรือบัญชี"),
      accountName: z.string().trim().min(1, "กรอกชื่อบัญชี").max(80),
      accessToken: z.string().trim().min(1, "กรอก access token"),
      appSecret: z.string().trim().optional(),
    })
    .parse(req.body ?? {});

  const channel = body.channel as Channel;
  const secrets =
    channel === Channel.X
      ? { accessToken: body.accessToken, consumerSecret: body.appSecret || "" }
      : { pageAccessToken: body.accessToken, appSecret: body.appSecret || META_APP_SECRET };

  if (channel !== Channel.X && !secrets.appSecret) {
    res.status(400).json({ error: "ต้องกรอก App secret ของ Meta เพื่อตรวจลายเซ็น webhook" });
    return;
  }

  const clash = await assertNotOwnedByOthers(channel, body.externalId, req.user!.workspaceId);
  if (clash) {
    res.status(409).json({ error: clash });
    return;
  }

  const conn = await prisma.connection.upsert({
    where: { channel_externalId: { channel, externalId: body.externalId } },
    create: {
      workspaceId: req.user!.workspaceId,
      channel,
      externalId: body.externalId,
      accountName: body.accountName,
      status: ConnectionStatus.CONNECTED,
      secrets: encryptJson(secrets),
    },
    update: {
      workspaceId: req.user!.workspaceId,
      accountName: body.accountName,
      status: ConnectionStatus.CONNECTED,
      lastError: null,
      secrets: encryptJson(secrets),
    },
  });

  await logEvent(req.user!.workspaceId, "channel.connected", `${channel} — ${conn.accountName}`);
  broadcast(req.user!.workspaceId, "connection", view(conn));
  res.json({ connection: view(conn), webhookUrl: publicWebhook(channel) });
});

/** เริ่ม OAuth ของ Meta (ใช้ได้เมื่อตั้ง META_APP_ID / META_APP_SECRET แล้ว) */
channelsRouter.get("/meta/oauth/start", requireAdmin, (req, res) => {
  if (!META_APP_ID || !META_APP_SECRET) {
    res.status(400).json({ error: "ยังไม่ได้ตั้งค่า META_APP_ID และ META_APP_SECRET" });
    return;
  }
  const redirect = `${env.publicUrl.replace(/\/$/, "")}/api/channels/meta/oauth/callback`;
  const scope = [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
  ].join(",");
  const url =
    `https://www.facebook.com/v21.0/dialog/oauth?client_id=${encodeURIComponent(META_APP_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirect)}&state=${encodeURIComponent(req.user!.workspaceId)}&scope=${encodeURIComponent(scope)}`;
  res.json({ url });
});

/** รับ code กลับมา แลกเป็น page token แล้วส่งรายชื่อเพจให้ผู้ใช้เลือก */
channelsRouter.get("/meta/oauth/callback", requireAdmin, async (req, res) => {
  const code = String(req.query.code || "");
  if (!code) {
    res.status(400).json({ error: "ไม่พบ code จาก Meta" });
    return;
  }
  const redirect = `${env.publicUrl.replace(/\/$/, "")}/api/channels/meta/oauth/callback`;
  try {
    const tokenRes = await fetch(
      `${GRAPH}/oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}&client_secret=${encodeURIComponent(
        META_APP_SECRET
      )}&redirect_uri=${encodeURIComponent(redirect)}&code=${encodeURIComponent(code)}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: { message?: string } };
    if (!tokenRes.ok || !tokenJson.access_token) {
      res.status(400).json({ error: tokenJson.error?.message || "แลก access token ไม่สำเร็จ" });
      return;
    }
    const pagesRes = await fetch(
      `${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(
        tokenJson.access_token
      )}`,
      { signal: AbortSignal.timeout(15000) }
    );
    const pagesJson = (await pagesRes.json()) as {
      data?: Array<{ id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } }>;
    };
    res.json({
      pages: (pagesJson.data || []).map((p) => ({
        id: p.id,
        name: p.name,
        accessToken: p.access_token,
        instagram: p.instagram_business_account
          ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username }
          : null,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: `ติดต่อ Meta ไม่ได้: ${err instanceof Error ? err.message : "error"}` });
  }
});

channelsRouter.patch("/:id", requireAdmin, async (req, res) => {
  const body = z.object({ botEnabled: z.boolean().optional() }).parse(req.body ?? {});
  const conn = await prisma.connection.findFirst({ where: { id: req.params.id, workspaceId: req.user!.workspaceId } });
  if (!conn) {
    res.status(404).json({ error: "ไม่พบช่องทาง" });
    return;
  }
  const updated = await prisma.connection.update({ where: { id: conn.id }, data: body });
  await logEvent(req.user!.workspaceId, "channel.updated", `${conn.channel} bot → ${updated.botEnabled ? "เปิด" : "ปิด"}`);
  broadcast(req.user!.workspaceId, "connection", view(updated));
  res.json({ connection: view(updated) });
});

channelsRouter.delete("/:id", requireAdmin, async (req, res) => {
  const conn = await prisma.connection.findFirst({ where: { id: req.params.id, workspaceId: req.user!.workspaceId } });
  if (!conn) {
    res.status(404).json({ error: "ไม่พบช่องทาง" });
    return;
  }
  // ลบ token ทิ้งทันที และคงบทสนทนาเก่าไว้ไม่ได้ เพราะผูกกับ connection
  await prisma.connection.delete({ where: { id: conn.id } });
  await logEvent(req.user!.workspaceId, "channel.disconnected", `${conn.channel} — ${conn.accountName}`);
  broadcast(req.user!.workspaceId, "refresh", { reason: "channel-removed" });
  res.json({ ok: true });
});
