import express from "express";
import cookieParser from "cookie-parser";
import { ZodError } from "zod";
import { env, assertProductionSafety } from "./env";
import { prisma } from "./db";
import { loadSession, requireAuth } from "./auth";
import { addClient } from "./realtime";
import { ensureSchema } from "./schema";
import { ensureCollection, health as qdrantHealth } from "./rag/qdrant";
import { authRouter } from "./routes/auth";
import { conversationsRouter } from "./routes/conversations";
import { channelsRouter } from "./routes/channels";
import { kbRouter } from "./routes/kb";
import { settingsRouter } from "./routes/settings";
import { analyticsRouter } from "./routes/analytics";
import { webhooksRouter } from "./routes/webhooks";

const app = express();
app.set("trust proxy", 1);

// webhook ต้องอ่าน raw body เพื่อตรวจลายเซ็น จึงลงทะเบียนก่อน express.json()
app.use("/webhooks", webhooksRouter);

app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

app.get("/api/health", async (_req, res) => {
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }
  res.json({ ok: db, db, qdrant: await qdrantHealth(), warnings: assertProductionSafety() });
});

app.use("/api/auth", authRouter);
app.use("/api/conversations", conversationsRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/kb", kbRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/analytics", analyticsRouter);

/** ช่องทางส่งเหตุการณ์แบบ realtime ให้หน้าเว็บ (Server-Sent Events) */
app.get("/api/stream", async (req, res) => {
  const user = await loadSession(req);
  if (!user) {
    res.status(401).json({ error: "ต้องเข้าสู่ระบบก่อน" });
    return;
  }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const remove = addClient(user.workspaceId, res);
  req.on("close", remove);
});

app.use("/api", requireAuth, (_req, res) => {
  res.status(404).json({ error: "ไม่พบ endpoint นี้" });
});

// ตัวจัดการ error กลาง — ไม่ส่ง stack trace ออกไปหา client
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: err.errors[0]?.message || "ข้อมูลไม่ถูกต้อง" });
    return;
  }
  const message = err instanceof Error ? err.message : "เกิดข้อผิดพลาด";
  if (/File too large/i.test(message)) {
    res.status(413).json({ error: `ไฟล์ใหญ่เกิน ${Math.round(env.upload.maxBytes / 1024 / 1024)} MB` });
    return;
  }
  console.error("[error]", err);
  res.status(500).json({ error: env.nodeEnv === "production" ? "เกิดข้อผิดพลาดภายในระบบ" : message });
});

async function main() {
  for (const w of assertProductionSafety()) console.warn("[warn]", w);

  await ensureSchema();
  console.log("[db] ตารางพร้อมใช้งาน");

  try {
    await ensureCollection();
    console.log(`[qdrant] collection "${env.qdrant.collection}" พร้อมใช้งาน (dim ${env.embedding.dim})`);
  } catch (err) {
    console.warn("[qdrant] ยังเชื่อมต่อไม่ได้ จะลองใหม่เมื่อมีการใช้งาน:", err instanceof Error ? err.message : err);
  }
  app.listen(env.port, () => {
    console.log(`[hub] backend พร้อมที่พอร์ต ${env.port} (${env.nodeEnv})`);
    console.log(`[hub] webhook URL สาธารณะ: ${env.publicUrl}/webhooks/{line|facebook|instagram|x}`);
  });
}

main().catch((err) => {
  console.error("เริ่มระบบไม่สำเร็จ:", err);
  process.exit(1);
});

process.on("SIGTERM", async () => {
  await prisma.$disconnect();
  process.exit(0);
});
