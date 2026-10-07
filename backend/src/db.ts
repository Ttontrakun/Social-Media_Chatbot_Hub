import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";
import { env } from "./env";

/**
 * Prisma 7 ต่อฐานข้อมูลผ่าน driver adapter (node-postgres)
 * ไม่ต้องดาวน์โหลด query engine แยก ทำให้ build ใน Docker เร็วและใช้ในเครือข่ายปิดได้
 */
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

export const prisma = new PrismaClient({
  adapter,
  log: process.env.PRISMA_LOG === "1" ? ["query", "warn", "error"] : ["warn", "error"],
});

export async function logEvent(workspaceId: string, kind: string, message: string): Promise<void> {
  try {
    await prisma.eventLog.create({ data: { workspaceId, kind, message } });
  } catch {
    // บันทึก log ล้มเหลวไม่ควรทำให้คำขอหลักพัง
  }
}
