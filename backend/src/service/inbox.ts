import { Channel, Connection, ConnectionStatus, Conversation, Sender } from "../generated/prisma/client";
import { prisma, logEvent } from "../db";
import { env } from "../env";
import { decryptJson } from "../crypto";
import { broadcast } from "../realtime";
import { adapters } from "../channels";
import { InboundMessage } from "../channels/types";
import { fetchLineProfile } from "../channels/line";
import { fetchMetaProfile } from "../channels/meta";
import { answerQuestion, BotConfig, matchHandoverTopic } from "../rag/answer";
import { notifyOutbound } from "./webhookOut";

const AVATAR_COLORS = ["#CDEBD9", "#D6E4FA", "#F9D9E6", "#E1E3E8", "#FFE5C7", "#DDE7CF"];

export async function getBotConfig(workspaceId: string): Promise<BotConfig> {
  const s = await prisma.botSetting.upsert({
    where: { workspaceId },
    create: { workspaceId, minScore: env.defaultMinScore },
    update: {},
  });
  return {
    persona: s.persona,
    fallback: s.fallback,
    minScore: s.minScore,
    topK: s.topK,
    handoverTopics: s.handoverTopics,
  };
}

export async function getBotMode(workspaceId: string): Promise<"AUTO" | "DRAFT"> {
  const s = await prisma.botSetting.upsert({ where: { workspaceId }, create: { workspaceId, minScore: env.defaultMinScore }, update: {} });
  return s.mode;
}

function secretsOf(conn: Connection): Record<string, string | undefined> {
  return decryptJson<Record<string, string>>(conn.secrets) || {};
}

async function resolveContactName(conn: Connection, externalId: string, given?: string): Promise<string> {
  if (given) return given;
  const s = secretsOf(conn);
  if (conn.channel === Channel.LINE && s.accessToken) {
    const name = await fetchLineProfile(s.accessToken, externalId);
    if (name) return name;
  }
  if ((conn.channel === Channel.FACEBOOK || conn.channel === Channel.INSTAGRAM) && s.pageAccessToken) {
    const name = await fetchMetaProfile(s.pageAccessToken, externalId);
    if (name) return name;
  }
  return `ผู้ใช้ ${externalId.slice(-6)}`;
}

/** หา Contact จาก identity ของช่องทางนั้น ถ้าไม่มีก็สร้างใหม่ */
async function findOrCreateContact(conn: Connection, msg: InboundMessage) {
  const existing = await prisma.contactIdentity.findUnique({
    where: {
      workspaceId_channel_externalId: {
        workspaceId: conn.workspaceId,
        channel: msg.channel,
        externalId: msg.contactExternalId,
      },
    },
    include: { contact: true },
  });
  if (existing) return existing.contact;

  const displayName = await resolveContactName(conn, msg.contactExternalId, msg.contactName);
  const contact = await prisma.contact.create({
    data: {
      workspaceId: conn.workspaceId,
      displayName,
      avatarColor: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)],
      identities: {
        create: {
          workspaceId: conn.workspaceId,
          channel: msg.channel,
          externalId: msg.contactExternalId,
          handle: msg.contactName,
        },
      },
    },
  });
  return contact;
}

async function findOrCreateConversation(conn: Connection, contactId: string): Promise<Conversation> {
  const existing = await prisma.conversation.findFirst({
    where: { connectionId: conn.id, contactId },
    orderBy: { lastMessageAt: "desc" },
  });
  if (existing) return existing;
  return prisma.conversation.create({
    data: { workspaceId: conn.workspaceId, connectionId: conn.id, contactId, mode: "BOT" },
  });
}

export async function conversationPayload(conversationId: string) {
  const c = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      contact: { include: { identities: true } },
      connection: true,
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  if (!c) return null;
  return {
    id: c.id,
    channel: c.connection.channel,
    accountName: c.connection.accountName,
    connectionStatus: c.connection.status,
    mode: c.mode,
    status: c.status,
    awaitingStaff: c.awaitingStaff,
    unread: c.unread,
    assignee: c.assignee,
    lastMessageAt: c.lastMessageAt,
    contact: {
      id: c.contact.id,
      name: c.contact.displayName,
      color: c.contact.avatarColor,
      tags: c.contact.tags,
      channels: c.contact.identities.map((i) => i.channel),
      since: c.contact.createdAt,
    },
    messages: c.messages.map((m) => ({
      id: m.id,
      sender: m.sender,
      body: m.body,
      sources: m.sources,
      at: m.createdAt,
    })),
  };
}

async function pushConversation(conversationId: string, workspaceId: string, event = "conversation") {
  const payload = await conversationPayload(conversationId);
  if (payload) broadcast(workspaceId, event, payload);
}

/** ส่งข้อความออกไปหาลูกค้าจริงผ่านแพลตฟอร์ม แล้วบันทึกลงฐานข้อมูล */
export async function sendOutbound(
  conversationId: string,
  text: string,
  sender: Sender,
  opts: { sources?: string[]; replyToken?: string } = {}
): Promise<{ ok: boolean; error?: string }> {
  const conv = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { connection: true, contact: { include: { identities: true } } },
  });
  if (!conv) return { ok: false, error: "ไม่พบบทสนทนา" };

  const conn = conv.connection;
  if (conn.status !== ConnectionStatus.CONNECTED) {
    return { ok: false, error: `ช่องทาง ${conn.channel} ${conn.status === "EXPIRED" ? "ต้องเชื่อมต่อใหม่" : "ยังไม่ได้เชื่อมต่อ"}` };
  }
  const identity = conv.contact.identities.find((i) => i.channel === conn.channel);
  if (!identity) return { ok: false, error: "ไม่พบ id ของลูกค้าในช่องทางนี้" };

  const adapter = adapters[conn.channel];
  const result = await adapter.send(secretsOf(conn), identity.externalId, text, { replyToken: opts.replyToken });

  if (!result.ok) {
    await logEvent(conn.workspaceId, "message.failed", `${conn.channel} → ${conv.contact.displayName}: ${result.error}`);
    // token ใช้ไม่ได้แล้ว → ทำเครื่องหมายว่าต้องเชื่อมต่อใหม่ เพื่อให้หน้าเว็บเตือน
    if (/401|403|invalid|expired/i.test(result.error || "")) {
      await prisma.connection.update({
        where: { id: conn.id },
        data: { status: ConnectionStatus.EXPIRED, lastError: result.error?.slice(0, 300) },
      });
      broadcast(conn.workspaceId, "connection", { id: conn.id, status: "EXPIRED", error: result.error });
    }
    return { ok: false, error: result.error };
  }

  await prisma.message.create({
    data: {
      conversationId,
      direction: "OUT",
      sender,
      body: text,
      sources: opts.sources || [],
      externalId: result.externalId,
    },
  });
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: new Date(), awaitingStaff: false },
  });
  await logEvent(conn.workspaceId, "message.sent", `${conn.channel} → ${conv.contact.displayName}`);
  notifyOutbound(conn.workspaceId, { conversationId, channel: conn.channel, sender, text }).catch(() => undefined);
  return { ok: true };
}

async function addSystemNote(conversationId: string, workspaceId: string, body: string) {
  await prisma.message.create({ data: { conversationId, direction: "IN", sender: Sender.SYSTEM, body } });
}

/**
 * หัวใจของระบบ: ข้อความลูกค้า 1 ข้อความเข้ามาแล้วเกิดอะไรขึ้นบ้าง
 * ใช้ร่วมกันทั้ง webhook จริงและปุ่มจำลองข้อความในหน้าเว็บ
 */
export async function handleInbound(msg: InboundMessage): Promise<void> {
  const conn = await prisma.connection.findUnique({
    where: { channel_externalId: { channel: msg.channel, externalId: msg.accountExternalId } },
  });
  if (!conn) return; // ไม่ใช่บัญชีของเรา

  const contact = await findOrCreateContact(conn, msg);
  const conv = await findOrCreateConversation(conn, contact.id);

  await prisma.message.create({
    data: {
      conversationId: conv.id,
      direction: "IN",
      sender: Sender.CUSTOMER,
      body: msg.text,
      externalId: msg.externalMessageId,
    },
  });
  await prisma.conversation.update({
    where: { id: conv.id },
    data: { lastMessageAt: msg.timestamp, unread: { increment: 1 }, status: "OPEN" },
  });
  await logEvent(conn.workspaceId, "message.received", `${conn.channel} จาก ${contact.displayName}`);

  const cfg = await getBotConfig(conn.workspaceId);
  const botMode = await getBotMode(conn.workspaceId);
  const botAvailable = conn.botEnabled && conn.status === ConnectionStatus.CONNECTED;

  const handover = async (note: string) => {
    await addSystemNote(conv.id, conn.workspaceId, note);
    await prisma.conversation.update({ where: { id: conv.id }, data: { mode: "HUMAN", awaitingStaff: true } });
    await pushConversation(conv.id, conn.workspaceId);
  };

  // บทสนทนาที่พนักงานรับช่วงไปแล้ว บอทไม่แทรก
  if (conv.mode === "HUMAN") {
    await prisma.conversation.update({ where: { id: conv.id }, data: { awaitingStaff: true } });
    await pushConversation(conv.id, conn.workspaceId);
    return;
  }

  if (!botAvailable) {
    await handover(
      conn.status !== ConnectionStatus.CONNECTED
        ? `ช่องทาง ${conn.channel} ต้องเชื่อมต่อใหม่ — บอทตอบกลับไม่ได้`
        : `บอทของ ${conn.channel} ปิดอยู่ — รอพนักงานตอบ`
    );
    return;
  }

  const topic = matchHandoverTopic(msg.text, cfg.handoverTopics);
  if (topic) {
    await handover(`หัวข้อ "${topic}" ต้องให้พนักงานดูแล — ส่งต่อแล้ว`);
    return;
  }

  if (botMode === "DRAFT") {
    await handover("โหมดร่างคำตอบ — AI เตรียมร่างให้แอดมินกดส่ง");
    return;
  }

  const answer = await answerQuestion(conn.workspaceId, msg.text, cfg);
  if (answer.kind === "answered") {
    const sent = await sendOutbound(conv.id, answer.text, Sender.BOT, {
      sources: answer.sources,
      replyToken: msg.replyToken,
    });
    if (!sent.ok) {
      await handover(`ส่งคำตอบของบอทไม่สำเร็จ: ${sent.error}`);
      return;
    }
    await pushConversation(conv.id, conn.workspaceId);
    return;
  }

  // บอทตอบไม่ได้ → แจ้งลูกค้าด้วยข้อความสำรอง แล้วส่งต่อพนักงาน
  if (answer.text) {
    await sendOutbound(conv.id, answer.text, Sender.BOT, { replyToken: msg.replyToken }).catch(() => undefined);
  }
  const why =
    answer.reason === "error"
      ? "ระบบค้นหาหรือ LLM มีปัญหา — ส่งต่อให้พนักงาน"
      : "บอทไม่พบคำตอบในฐานความรู้ — ส่งต่อให้พนักงาน";
  await handover(why);
}

export { pushConversation };
