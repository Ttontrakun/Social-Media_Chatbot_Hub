import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { prisma, logEvent } from "../db";
import { requireAuth, requireAdmin } from "../auth";
import { env } from "../env";
import { ingestDocument, removeDocument } from "../rag/ingest";
import { health as qdrantHealth } from "../rag/qdrant";
import { getBotConfig } from "../service/inbox";
import { answerQuestion, expandQueryVariants, retrieve } from "../rag/answer";

export const kbRouter = Router();
kbRouter.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.upload.maxBytes, files: 10 },
});

kbRouter.get("/", async (req, res) => {
  const docs = await prisma.document.findMany({
    where: { workspaceId: req.user!.workspaceId },
    orderBy: { createdAt: "desc" },
  });
  res.json({
    documents: docs.map((d) => ({
      id: d.id,
      filename: d.filename,
      status: d.status,
      chunkCount: d.chunkCount,
      bytes: d.bytes,
      error: d.error,
      createdAt: d.createdAt,
    })),
    engine: {
      embeddingProvider: env.embedding.provider,
      embeddingModel: env.embedding.model,
      dim: env.embedding.dim,
      llmProvider: env.llm.provider,
      llmModel: env.llm.model,
      qdrant: await qdrantHealth(),
      ocr: Boolean(env.ocr.url),
      rerank: env.rerank.enabled && Boolean(env.rerank.url),
    },
  });
});

kbRouter.post("/", requireAdmin, upload.array("files", 10), async (req, res) => {
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (!files.length) {
    res.status(400).json({ error: "ไม่พบไฟล์ที่อัปโหลด" });
    return;
  }

  const created = [];
  for (const f of files) {
    const filename = Buffer.from(f.originalname, "latin1").toString("utf8");
    const doc = await prisma.document.create({
      data: {
        workspaceId: req.user!.workspaceId,
        filename,
        mimeType: f.mimetype,
        bytes: f.size,
        status: "PENDING",
      },
    });
    created.push({ id: doc.id, filename: doc.filename, status: doc.status, chunkCount: 0, bytes: doc.bytes });
    await logEvent(req.user!.workspaceId, "kb.upload", filename);
    // ประมวลผลเบื้องหลัง ไม่ให้ผู้ใช้รอ
    void ingestDocument(doc.id, req.user!.workspaceId, f.buffer, filename, f.mimetype);
  }
  res.json({ documents: created });
});

kbRouter.delete("/:id", requireAdmin, async (req, res) => {
  const doc = await prisma.document.findFirst({ where: { id: req.params.id, workspaceId: req.user!.workspaceId } });
  if (!doc) {
    res.status(404).json({ error: "ไม่พบเอกสาร" });
    return;
  }
  await removeDocument(req.user!.workspaceId, doc.id);
  await logEvent(req.user!.workspaceId, "kb.deleted", doc.filename);
  res.json({ ok: true });
});

/** ลองถามบอทก่อนเปิดใช้งานจริง — เห็นทั้งคำตอบและช่วงข้อความที่ถูกอ้างอิง */
kbRouter.post("/test", async (req, res) => {
  const body = z.object({ question: z.string().trim().min(1).max(1000) }).parse(req.body ?? {});
  const cfg = await getBotConfig(req.user!.workspaceId);
  try {
    // ใช้เส้นทางค้นหาเดียวกับที่บอทใช้จริง จะได้เห็นผลตรงกับตอนลูกค้าถาม
    const hits = await retrieve(req.user!.workspaceId, body.question, cfg);
    const answer = await answerQuestion(req.user!.workspaceId, body.question, cfg);
    res.json({
      answer: answer.kind === "answered" ? answer.text : cfg.fallback,
      confident: answer.kind === "answered",
      reason: answer.reason ?? null,
      sources: answer.sources,
      variants: expandQueryVariants(body.question),
      hits: hits.map((h) => ({
        score: Number(h.score.toFixed(4)),
        rerankScore: h.rerankScore ?? null,
        filename: h.payload.filename,
        chunkIndex: h.payload.chunkIndex,
        label: h.payload.label ?? null,
        expanded: Boolean(h.expandedText),
        text: (h.expandedText || h.payload.text).slice(0, 600),
      })),
      minScore: cfg.minScore,
    });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "ค้นหาไม่สำเร็จ" });
  }
});
