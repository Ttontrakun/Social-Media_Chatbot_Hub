import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { env } from "../env";
import { clearSession, hashPassword, issueSession, loadSession, verifyPassword } from "../auth";

export const authRouter = Router();

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("รูปแบบอีเมลไม่ถูกต้อง"),
  password: z.string().min(8, "รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร"),
});

const signupSchema = credentials.extend({
  name: z.string().trim().min(1, "กรุณากรอกชื่อ").max(80),
  workspace: z.string().trim().max(80).optional(),
});

function fail(res: any, err: unknown) {
  if (err instanceof z.ZodError) {
    res.status(400).json({ error: err.errors[0]?.message || "ข้อมูลไม่ถูกต้อง" });
    return true;
  }
  return false;
}

authRouter.post("/signup", async (req, res) => {
  let data: z.infer<typeof signupSchema>;
  try {
    data = signupSchema.parse(req.body);
  } catch (err) {
    if (fail(res, err)) return;
    throw err;
  }

  const existing = await prisma.user.findUnique({ where: { email: data.email } });
  if (existing) {
    res.status(409).json({ error: "อีเมลนี้มีบัญชีอยู่แล้ว" });
    return;
  }

  const user = await prisma.user.create({
    data: {
      email: data.email,
      name: data.name,
      passwordHash: await hashPassword(data.password),
      memberships: {
        create: {
          role: "OWNER",
          workspace: { create: { name: data.workspace || `ร้านของ ${data.name}` } },
        },
      },
    },
    include: { memberships: { include: { workspace: true } } },
  });

  const membership = user.memberships[0];
  await prisma.botSetting.create({ data: { workspaceId: membership.workspaceId, minScore: env.defaultMinScore } });
  issueSession(res, { userId: user.id, workspaceId: membership.workspaceId });
  res.json({
    user: { email: user.email, name: user.name, workspace: membership.workspace.name, role: membership.role },
  });
});

authRouter.post("/login", async (req, res) => {
  let data: z.infer<typeof credentials>;
  try {
    data = credentials.parse(req.body);
  } catch (err) {
    if (fail(res, err)) return;
    throw err;
  }

  const user = await prisma.user.findUnique({
    where: { email: data.email },
    include: { memberships: { include: { workspace: true }, orderBy: { createdAt: "asc" } } },
  });
  // ข้อความเดียวกันทั้งกรณีไม่มีบัญชีและรหัสผ่านผิด เพื่อไม่บอกใบ้ว่าอีเมลไหนมีอยู่จริง
  const invalid = () => res.status(401).json({ error: "อีเมลหรือรหัสผ่านไม่ถูกต้อง" });
  if (!user || !user.memberships.length) return invalid();
  if (!(await verifyPassword(data.password, user.passwordHash))) return invalid();

  const membership = user.memberships[0];
  issueSession(res, { userId: user.id, workspaceId: membership.workspaceId });
  res.json({
    user: { email: user.email, name: user.name, workspace: membership.workspace.name, role: membership.role },
  });
});

authRouter.post("/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

authRouter.get("/me", async (req, res) => {
  const user = await loadSession(req);
  if (!user) {
    res.status(401).json({ error: "ยังไม่ได้เข้าสู่ระบบ" });
    return;
  }
  res.json({ user: { email: user.email, name: user.name, workspace: user.workspaceName, role: user.role } });
});
