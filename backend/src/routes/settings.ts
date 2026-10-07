import { Router } from "express";
import { z } from "zod";
import { prisma, logEvent } from "../db";
import { requireAuth, requireAdmin } from "../auth";
import { hashKey, randomKey } from "../crypto";
import { env, assertProductionSafety } from "../env";

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get("/", async (req, res) => {
  const ws = req.user!.workspaceId;
  const s = await prisma.botSetting.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, minScore: env.defaultMinScore }, update: {} });
  const keys = await prisma.apiKey.findMany({ where: { workspaceId: ws }, orderBy: { createdAt: "desc" } });
  res.json({
    bot: {
      persona: s.persona,
      mode: s.mode,
      handoverTopics: s.handoverTopics,
      fallback: s.fallback,
      minScore: s.minScore,
      topK: s.topK,
    },
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      webhookUrl: k.webhookUrl,
      webhookOn: k.webhookOn,
      lastUsedAt: k.lastUsedAt,
      createdAt: k.createdAt,
    })),
    engine: {
      embeddingProvider: env.embedding.provider,
      embeddingModel: env.embedding.model,
      llmProvider: env.llm.provider,
      llmModel: env.llm.model,
    },
    warnings: assertProductionSafety(),
  });
});

settingsRouter.patch("/bot", requireAdmin, async (req, res) => {
  const body = z
    .object({
      persona: z.string().trim().min(1).max(4000).optional(),
      mode: z.enum(["AUTO", "DRAFT"]).optional(),
      handoverTopics: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      fallback: z.string().trim().min(1).max(1000).optional(),
      minScore: z.number().min(0).max(1).optional(),
      topK: z.number().int().min(1).max(20).optional(),
    })
    .parse(req.body ?? {});

  const ws = req.user!.workspaceId;
  const s = await prisma.botSetting.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, minScore: env.defaultMinScore, ...body }, update: body });
  await logEvent(ws, "bot.settings.saved", `โหมด ${s.mode}`);
  res.json({
    bot: {
      persona: s.persona,
      mode: s.mode,
      handoverTopics: s.handoverTopics,
      fallback: s.fallback,
      minScore: s.minScore,
      topK: s.topK,
    },
  });
});

settingsRouter.post("/api-keys", requireAdmin, async (req, res) => {
  const body = z.object({ name: z.string().trim().min(1).max(60).default("default") }).parse(req.body ?? {});
  const { key, hash, prefix } = randomKey("hub_live");
  const row = await prisma.apiKey.create({
    data: { workspaceId: req.user!.workspaceId, name: body.name, keyHash: hash, prefix },
  });
  await logEvent(req.user!.workspaceId, "api_key.created", body.name);
  // คืน key เต็มครั้งเดียวเท่านั้น หลังจากนี้ในฐานข้อมูลเหลือแค่ hash
  res.json({ id: row.id, name: row.name, prefix: row.prefix, key });
});

settingsRouter.patch("/api-keys/:id", requireAdmin, async (req, res) => {
  const body = z
    .object({
      webhookUrl: z.string().trim().url("URL ไม่ถูกต้อง").nullable().optional(),
      webhookOn: z.boolean().optional(),
    })
    .parse(req.body ?? {});
  const row = await prisma.apiKey.findFirst({ where: { id: req.params.id, workspaceId: req.user!.workspaceId } });
  if (!row) {
    res.status(404).json({ error: "ไม่พบ API key" });
    return;
  }
  const updated = await prisma.apiKey.update({ where: { id: row.id }, data: body });
  res.json({ id: updated.id, webhookUrl: updated.webhookUrl, webhookOn: updated.webhookOn });
});

settingsRouter.delete("/api-keys/:id", requireAdmin, async (req, res) => {
  const row = await prisma.apiKey.findFirst({ where: { id: req.params.id, workspaceId: req.user!.workspaceId } });
  if (!row) {
    res.status(404).json({ error: "ไม่พบ API key" });
    return;
  }
  await prisma.apiKey.delete({ where: { id: row.id } });
  res.json({ ok: true });
});

settingsRouter.get("/events", async (req, res) => {
  const rows = await prisma.eventLog.findMany({
    where: { workspaceId: req.user!.workspaceId },
    orderBy: { createdAt: "desc" },
    take: 60,
  });
  res.json({ events: rows.map((e) => ({ at: e.createdAt, kind: e.kind, message: e.message })) });
});

/** ตรวจว่า API key ที่ระบบภายนอกส่งมาถูกต้องไหม (ใช้กับ endpoint ภายนอกในอนาคต) */
export async function workspaceFromApiKey(key: string): Promise<string | null> {
  const row = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!row) return null;
  await prisma.apiKey.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } });
  return row.workspaceId;
}
