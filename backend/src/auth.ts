import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { NextFunction, Request, Response } from "express";
import { env } from "./env";
import { prisma } from "./db";

const COOKIE = "hub_session";

export interface SessionUser {
  userId: string;
  workspaceId: string;
  email: string;
  name: string;
  workspaceName: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: SessionUser;
    }
  }
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export function issueSession(res: Response, payload: { userId: string; workspaceId: string }): void {
  const token = jwt.sign(payload, env.jwtSecret, { expiresIn: "7d" });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    maxAge: 7 * 24 * 3600 * 1000,
    path: "/",
  });
}

export function clearSession(res: Response): void {
  res.clearCookie(COOKIE, { path: "/" });
}

export async function loadSession(req: Request): Promise<SessionUser | null> {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  let decoded: { userId: string; workspaceId: string };
  try {
    decoded = jwt.verify(token, env.jwtSecret) as typeof decoded;
  } catch {
    return null;
  }
  const member = await prisma.membership.findUnique({
    where: { userId_workspaceId: { userId: decoded.userId, workspaceId: decoded.workspaceId } },
    include: { user: true, workspace: true },
  });
  if (!member) return null;
  return {
    userId: member.userId,
    workspaceId: member.workspaceId,
    email: member.user.email,
    name: member.user.name,
    workspaceName: member.workspace.name,
    role: member.role,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await loadSession(req);
  if (!user) {
    res.status(401).json({ error: "ต้องเข้าสู่ระบบก่อน" });
    return;
  }
  req.user = user;
  next();
}

/** พนักงาน (AGENT) ตอบแชทได้ แต่แก้การตั้งค่าระบบไม่ได้ */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "ต้องเข้าสู่ระบบก่อน" });
    return;
  }
  if (req.user.role === "AGENT") {
    res.status(403).json({ error: "บัญชีนี้ไม่มีสิทธิ์แก้การตั้งค่า" });
    return;
  }
  next();
}
