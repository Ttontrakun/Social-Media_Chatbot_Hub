import { defineConfig } from "prisma/config";

/**
 * Prisma 7 ย้ายการตั้งค่าการเชื่อมต่อออกจาก schema.prisma มาไว้ที่ไฟล์นี้
 * ใช้เฉพาะคำสั่ง CLI (migrate, db push, studio) — ตัวแอปเชื่อมผ่าน adapter ใน src/db.ts
 *
 * ใช้ process.env ตรง ๆ แทน env() ของ Prisma เพราะ env() จะโยน error ทันทีเมื่อไม่มีค่า
 * ทำให้ `prisma generate` ตอน build ใน Docker พัง ทั้งที่ขั้นตอนนั้นยังไม่ต้องใช้ฐานข้อมูล
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL ?? "" },
});
