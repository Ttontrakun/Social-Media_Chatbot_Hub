-- โครงสร้างฐานข้อมูลที่ตรงกับ prisma/schema.prisma
-- ใช้ตอนเริ่มระบบเพื่อให้ตารางพร้อมใช้งานโดยไม่ต้องรัน prisma migrate
-- ถ้าแก้ schema.prisma ต้องแก้ไฟล์นี้ให้ตรงกันด้วย (หรือใช้ prisma migrate แทน)

DO $$ BEGIN CREATE TYPE "Role" AS ENUM ('OWNER','ADMIN','AGENT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Channel" AS ENUM ('LINE','FACEBOOK','INSTAGRAM','X'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED','EXPIRED','DISCONNECTED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ConversationMode" AS ENUM ('BOT','HUMAN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "ConversationStatus" AS ENUM ('OPEN','CLOSED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Direction" AS ENUM ('IN','OUT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "Sender" AS ENUM ('CUSTOMER','BOT','AGENT','SYSTEM'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "DocStatus" AS ENUM ('PENDING','PROCESSING','READY','FAILED'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE "BotMode" AS ENUM ('AUTO','DRAFT'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "User" (
  "id"           TEXT NOT NULL,
  "email"        TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

CREATE TABLE IF NOT EXISTS "Workspace" (
  "id"        TEXT NOT NULL,
  "name"      TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Membership" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "role"        "Role" NOT NULL DEFAULT 'OWNER',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Membership_userId_workspaceId_key" ON "Membership"("userId","workspaceId");

CREATE TABLE IF NOT EXISTS "Connection" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "channel"     "Channel" NOT NULL,
  "externalId"  TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "status"      "ConnectionStatus" NOT NULL DEFAULT 'CONNECTED',
  "botEnabled"  BOOLEAN NOT NULL DEFAULT true,
  "secrets"     TEXT,
  "lastError"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Connection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "Connection_channel_externalId_key" ON "Connection"("channel","externalId");
CREATE INDEX IF NOT EXISTS "Connection_workspaceId_idx" ON "Connection"("workspaceId");

CREATE TABLE IF NOT EXISTS "Contact" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "avatarColor" TEXT,
  "tags"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Contact_workspaceId_idx" ON "Contact"("workspaceId");

CREATE TABLE IF NOT EXISTS "ContactIdentity" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "contactId"   TEXT NOT NULL,
  "channel"     "Channel" NOT NULL,
  "externalId"  TEXT NOT NULL,
  "handle"      TEXT,
  CONSTRAINT "ContactIdentity_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContactIdentity_workspaceId_channel_externalId_key" ON "ContactIdentity"("workspaceId","channel","externalId");
CREATE INDEX IF NOT EXISTS "ContactIdentity_contactId_idx" ON "ContactIdentity"("contactId");

CREATE TABLE IF NOT EXISTS "Conversation" (
  "id"            TEXT NOT NULL,
  "workspaceId"   TEXT NOT NULL,
  "connectionId"  TEXT NOT NULL,
  "contactId"     TEXT NOT NULL,
  "mode"          "ConversationMode" NOT NULL DEFAULT 'BOT',
  "status"        "ConversationStatus" NOT NULL DEFAULT 'OPEN',
  "awaitingStaff" BOOLEAN NOT NULL DEFAULT false,
  "unread"        INTEGER NOT NULL DEFAULT 0,
  "assignee"      TEXT,
  "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Conversation_workspaceId_lastMessageAt_idx" ON "Conversation"("workspaceId","lastMessageAt");

CREATE TABLE IF NOT EXISTS "Message" (
  "id"             TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "direction"      "Direction" NOT NULL,
  "sender"         "Sender" NOT NULL,
  "body"           TEXT NOT NULL,
  "sources"        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "externalId"     TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Message_conversationId_createdAt_idx" ON "Message"("conversationId","createdAt");

CREATE TABLE IF NOT EXISTS "Document" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "filename"    TEXT NOT NULL,
  "mimeType"    TEXT NOT NULL,
  "bytes"       INTEGER NOT NULL,
  "status"      "DocStatus" NOT NULL DEFAULT 'PENDING',
  "chunkCount"  INTEGER NOT NULL DEFAULT 0,
  "error"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Document_workspaceId_idx" ON "Document"("workspaceId");

CREATE TABLE IF NOT EXISTS "BotSetting" (
  "workspaceId"    TEXT NOT NULL,
  "persona"        TEXT NOT NULL DEFAULT 'เป็นแอดมินร้าน พูดสุภาพ ตอบสั้นกระชับ ใช้ภาษาเดียวกับลูกค้า ตอบจากฐานความรู้เท่านั้น ห้ามเดา',
  "mode"           "BotMode" NOT NULL DEFAULT 'DRAFT',
  "handoverTopics" TEXT[] NOT NULL DEFAULT ARRAY['ร้องเรียน','คืนเงิน','ชำระเงิน']::TEXT[],
  "fallback"       TEXT NOT NULL DEFAULT 'ขออภัยค่ะ ขอตรวจสอบข้อมูลและแจ้งกลับให้นะคะ',
  "minScore"       DOUBLE PRECISION NOT NULL DEFAULT 0.35,
  "topK"           INTEGER NOT NULL DEFAULT 5,
  "updatedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "BotSetting_pkey" PRIMARY KEY ("workspaceId")
);

CREATE TABLE IF NOT EXISTS "ApiKey" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "keyHash"     TEXT NOT NULL,
  "prefix"      TEXT NOT NULL,
  "webhookUrl"  TEXT,
  "webhookOn"   BOOLEAN NOT NULL DEFAULT false,
  "lastUsedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX IF NOT EXISTS "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

CREATE TABLE IF NOT EXISTS "EventLog" (
  "id"          TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "kind"        TEXT NOT NULL,
  "message"     TEXT NOT NULL,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "EventLog_workspaceId_createdAt_idx" ON "EventLog"("workspaceId","createdAt");

-- ความสัมพันธ์ระหว่างตาราง (ลบต้นทางแล้วลบลูกตาม)
DO $$ BEGIN
  ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Contact" ADD CONSTRAINT "Contact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "Connection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "Document" ADD CONSTRAINT "Document_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "BotSetting" ADD CONSTRAINT "BotSetting_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
