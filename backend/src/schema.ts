import fs from "fs";
import path from "path";
import { prisma } from "./db";

/**
 * สร้างตารางให้ครบตอนเริ่มระบบ โดยไม่ต้องรัน prisma migrate
 * ไฟล์ init.sql เขียนแบบ idempotent (รันซ้ำได้ ไม่พัง) จึงเรียกทุกครั้งที่บูตได้
 * ถ้าต้องการใช้ migration ของ Prisma ให้ตั้ง SKIP_DB_INIT=1 แล้วรัน prisma migrate deploy เอง
 */
export async function ensureSchema(): Promise<void> {
  if (process.env.SKIP_DB_INIT === "1") return;
  const candidates = [
    path.join(__dirname, "..", "prisma", "init.sql"),
    path.join(process.cwd(), "prisma", "init.sql"),
  ];
  const file = candidates.find((p) => fs.existsSync(p));
  if (!file) throw new Error("ไม่พบไฟล์ prisma/init.sql");
  const sql = fs.readFileSync(file, "utf8");
  await prisma.$executeRawUnsafe(sql);
}
