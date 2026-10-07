import { Router } from "express";
import { z } from "zod";
import { Sender } from "../generated/prisma/client";
import { prisma, logEvent } from "../db";
import { requireAuth } from "../auth";
import { broadcast } from "../realtime";
import { conversationPayload, getBotConfig, pushConversation, sendOutbound } from "../service/inbox";
import { answerQuestion } from "../rag/answer";
import { handleInbound } from "../service/inbox";
import { Channel } from "../generated/prisma/client";

export const conversationsRouter = Router();
conversationsRouter.use(requireAuth);

/** รายการแชททั้งหมด เรียงให้เคสที่รอพนักงานขึ้นก่อน */
conversationsRouter.get("/", async (req, res) => {
  const ws = req.user!.workspaceId;
  const rows = await prisma.conversation.findMany({
    where: { workspaceId: ws },
    include: {
      contact: true,
      connection: true,
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 200,
  });

  const list = rows.map((c) => ({
    id: c.id,
    channel: c.connection.channel,
    connectionStatus: c.connection.status,
    name: c.contact.displayName,
    color: c.contact.avatarColor,
    mode: c.mode,
    status: c.status,
    awaitingStaff: c.awaitingStaff,
    unread: c.unread,
    assignee: c.assignee,
    lastMessageAt: c.lastMessageAt,
    preview: c.messages[0]
      ? { sender: c.messages[0].sender, body: c.messages[0].body }
      : null,
  }));
  list.sort((a, b) => {
    const rank = (x: typeof a) => (x.status === "CLOSED" ? 2 : x.awaitingStaff ? 0 : 1);
    return rank(a) - rank(b) || +new Date(b.lastMessageAt) - +new Date(a.lastMessageAt);
  });
  res.json({ conversations: list });
});

conversationsRouter.get("/:id", async (req, res) => {
  const conv = await prisma.conversation.findFirst({
    where: { id: req.params.id, workspaceId: req.user!.workspaceId },
    select: { id: true },
  });
  if (!conv) {
    res.status(404).json({ error: "ไม่พบบทสนทนา" });
    return;
  }
  await prisma.conversation.update({ where: { id: conv.id }, data: { unread: 0 } });
  res.json(await conversationPayload(conv.id));
});

async function owned(req: any, res: any) {
  const conv = await prisma.conversation.findFirst({
    where: { id: req.params.id, workspaceId: req.user.workspaceId },
    include: { connection: true, contact: true },
  });
  if (!conv) {
    res.status(404).json({ error: "ไม่พบบทสนทนา" });
    return null;
  }
  return conv;
}

/** พนักงานส่งข้อความ — บอทหยุดดูแลบทสนทนานี้โดยอัตโนมัติ */
conversationsRouter.post("/:id/messages", async (req, res) => {
  const conv = await owned(req, res);
  if (!conv) return;

  const body = z.object({ text: z.string().trim().min(1, "กรุณาพิมพ์ข้อความ").max(5000) });
  let text: string;
  try {
    text = body.parse(req.body).text;
  } catch (err: any) {
    res.status(400).json({ error: err?.errors?.[0]?.message || "ข้อความไม่ถูกต้อง" });
    return;
  }

  if (conv.mode === "BOT") {
    await prisma.message.create({
      data: { conversationId: conv.id, direction: "IN", sender: Sender.SYSTEM, body: "พนักงานเข้ามาตอบ — Bot หยุดอัตโนมัติ" },
    });
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: "HUMAN" } });
  }

  const sent = await sendOutbound(conv.id, text, Sender.AGENT);
  if (!sent.ok) {
    await pushConversation(conv.id, req.user!.workspaceId);
    res.status(502).json({ error: sent.error });
    return;
  }
  await pushConversation(conv.id, req.user!.workspaceId);
  res.json(await conversationPayload(conv.id));
});

/** ขอให้ AI ร่างคำตอบจากฐานความรู้ ยังไม่ส่งให้ลูกค้า */
conversationsRouter.post("/:id/draft", async (req, res) => {
  const conv = await owned(req, res);
  if (!conv) return;

  const lastCustomer = await prisma.message.findFirst({
    where: { conversationId: conv.id, sender: Sender.CUSTOMER },
    orderBy: { createdAt: "desc" },
  });
  if (!lastCustomer) {
    res.json({ text: "", note: "ยังไม่มีคำถามจากลูกค้า" });
    return;
  }

  const cfg = await getBotConfig(req.user!.workspaceId);
  const answer = await answerQuestion(req.user!.workspaceId, lastCustomer.body, cfg);
  res.json({
    text: answer.kind === "answered" ? answer.text : cfg.fallback,
    sources: answer.sources,
    confident: answer.kind === "answered",
    score: answer.score ?? null,
    question: lastCustomer.body,
  });
});

conversationsRouter.patch("/:id", async (req, res) => {
  const conv = await owned(req, res);
  if (!conv) return;

  const body = z
    .object({
      mode: z.enum(["BOT", "HUMAN"]).optional(),
      status: z.enum(["OPEN", "CLOSED"]).optional(),
      assignee: z.string().trim().max(80).nullable().optional(),
      unread: z.literal(0).optional(),
    })
    .parse(req.body ?? {});

  const data: Record<string, unknown> = {};
  if (body.mode && body.mode !== conv.mode) {
    data.mode = body.mode;
    if (body.mode === "BOT") data.awaitingStaff = false;
    await prisma.message.create({
      data: {
        conversationId: conv.id,
        direction: "IN",
        sender: Sender.SYSTEM,
        body: body.mode === "BOT" ? "เปิดโหมด Bot อีกครั้ง" : "สลับเป็นพนักงานตอบ",
      },
    });
  }
  if (body.status) {
    data.status = body.status;
    if (body.status === "CLOSED") data.awaitingStaff = false;
  }
  if (body.assignee !== undefined) data.assignee = body.assignee;
  if (body.unread === 0) data.unread = 0;

  await prisma.conversation.update({ where: { id: conv.id }, data });
  await pushConversation(conv.id, req.user!.workspaceId);
  res.json(await conversationPayload(conv.id));
});

conversationsRouter.patch("/:id/tags", async (req, res) => {
  const conv = await owned(req, res);
  if (!conv) return;
  const body = z.object({ tags: z.array(z.string().trim().min(1).max(40)).max(20) }).parse(req.body ?? {});
  await prisma.contact.update({ where: { id: conv.contactId }, data: { tags: body.tags } });
  await pushConversation(conv.id, req.user!.workspaceId);
  res.json(await conversationPayload(conv.id));
});

/**
 * จำลองข้อความลูกค้าเข้ามา — ใช้ทดสอบบอทโดยไม่ต้องรอข้อความจริง
 * เดินผ่าน flow เดียวกับ webhook ทุกขั้นตอน ต่างแค่ไม่ได้ส่งออกไปแพลตฟอร์มจริง
 */
conversationsRouter.post("/simulate", async (req, res) => {
  const body = z
    .object({
      channel: z.nativeEnum(Channel),
      text: z.string().trim().min(1).max(2000),
      contactExternalId: z.string().trim().min(1).max(120),
      contactName: z.string().trim().max(80).optional(),
    })
    .parse(req.body ?? {});

  const conn = await prisma.connection.findFirst({
    where: { workspaceId: req.user!.workspaceId, channel: body.channel },
  });
  if (!conn) {
    res.status(400).json({ error: `ยังไม่ได้เชื่อมต่อช่องทาง ${body.channel}` });
    return;
  }

  await handleInbound({
    channel: body.channel,
    accountExternalId: conn.externalId,
    contactExternalId: body.contactExternalId,
    contactName: body.contactName,
    text: body.text,
    timestamp: new Date(),
  });
  await logEvent(req.user!.workspaceId, "simulate", `${body.channel}: ${body.text.slice(0, 60)}`);
  broadcast(req.user!.workspaceId, "refresh", { reason: "simulate" });
  res.json({ ok: true });
});
