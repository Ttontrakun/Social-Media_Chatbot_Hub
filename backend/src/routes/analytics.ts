import { Router } from "express";
import { Channel, Sender } from "../generated/prisma/client";
import { prisma } from "../db";
import { requireAuth } from "../auth";

export const analyticsRouter = Router();
analyticsRouter.use(requireAuth);

/**
 * คีย์วันตามเวลาท้องถิ่นของเซิร์ฟเวอร์
 * ห้ามใช้ toISOString() เพราะจะได้วันที่แบบ UTC ทำให้ข้อความของวันนี้
 * ตกไปอยู่นอกช่วงที่คำนวณไว้เมื่อเซิร์ฟเวอร์ไม่ได้อยู่โซน UTC (เช่น +07:00)
 */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** สรุปตัวเลขสำหรับหน้าแดชบอร์ด คำนวณจากข้อความจริงในฐานข้อมูล */
analyticsRouter.get("/", async (req, res) => {
  const ws = req.user!.workspaceId;
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));

  const messages = await prisma.message.findMany({
    where: { createdAt: { gte: since }, conversation: { workspaceId: ws } },
    select: {
      sender: true,
      createdAt: true,
      conversation: { select: { connection: { select: { channel: true } } } },
    },
  });

  const labels: string[] = [];
  const index = new Map<string, number>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(since.getDate() + i);
    const key = dayKey(d);
    index.set(key, i);
    labels.push(
      d.toLocaleDateString("th-TH", { day: "numeric", month: "short" })
    );
  }

  const channels = Object.values(Channel);
  const perChannel: Record<string, number[]> = Object.fromEntries(channels.map((c) => [c, new Array(days).fill(0)]));
  const botPerDay = new Array<number>(days).fill(0);
  const agentPerDay = new Array<number>(days).fill(0);
  const hours = new Array<number>(24).fill(0);
  const channelTotals: Record<string, number> = Object.fromEntries(channels.map((c) => [c, 0]));

  for (const m of messages) {
    const i = index.get(dayKey(m.createdAt));
    if (i === undefined) continue;
    const ch = m.conversation.connection.channel;
    if (m.sender === Sender.CUSTOMER) {
      perChannel[ch][i] += 1;
      channelTotals[ch] += 1;
      hours[m.createdAt.getHours()] += 1;
    } else if (m.sender === Sender.BOT) {
      botPerDay[i] += 1;
    } else if (m.sender === Sender.AGENT) {
      agentPerDay[i] += 1;
    }
  }

  const [openCount, waitingCount, totalDocs] = await Promise.all([
    prisma.conversation.count({ where: { workspaceId: ws, status: "OPEN" } }),
    prisma.conversation.count({ where: { workspaceId: ws, status: "OPEN", awaitingStaff: true } }),
    prisma.document.count({ where: { workspaceId: ws, status: "READY" } }),
  ]);

  const inbound = Object.values(perChannel).reduce((a, arr) => a + arr.reduce((x, y) => x + y, 0), 0);
  const botTotal = botPerDay.reduce((a, b) => a + b, 0);
  const agentTotal = agentPerDay.reduce((a, b) => a + b, 0);

  // เวลาตอบแรกเฉลี่ย: ข้อความลูกค้า → ข้อความตอบถัดไปในบทสนทนาเดียวกัน
  const convos = await prisma.conversation.findMany({
    where: { workspaceId: ws, lastMessageAt: { gte: since } },
    select: { messages: { orderBy: { createdAt: "asc" }, select: { sender: true, createdAt: true } } },
    take: 300,
  });
  const gaps: number[] = [];
  for (const c of convos) {
    let pending: Date | null = null;
    for (const m of c.messages) {
      if (m.sender === Sender.CUSTOMER) {
        if (!pending) pending = m.createdAt;
      } else if ((m.sender === Sender.BOT || m.sender === Sender.AGENT) && pending) {
        gaps.push((+m.createdAt - +pending) / 1000);
        pending = null;
      }
    }
  }
  const avgSeconds = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  res.json({
    days,
    labels,
    perChannel,
    channelTotals,
    botPerDay,
    agentPerDay,
    hours,
    kpi: {
      waiting: waitingCount,
      open: openCount,
      inbound,
      botRate: botTotal + agentTotal > 0 ? Math.round((botTotal / (botTotal + agentTotal)) * 100) : null,
      avgFirstReplySeconds: avgSeconds,
      readyDocuments: totalDocs,
    },
  });
});
