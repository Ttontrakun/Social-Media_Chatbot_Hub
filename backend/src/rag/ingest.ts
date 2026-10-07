import { prisma, logEvent } from "../db";
import { broadcast } from "../realtime";
import { chunkTextForBlocks } from "./chunk";
import { embed } from "./embed";
import { extractText } from "./extract";
import { ChunkPayload, upsertChunks, deleteDocument } from "./qdrant";

/** id ของบล็อกแม่ — ใช้รวม chunk ลูกกลับเป็นบล็อกเดิมตอนค้นหา */
const parentIdOf = (documentId: string, filename: string, blockIndex: number) =>
  `${documentId}::${filename}::${blockIndex}`;

/**
 * ไปป์ไลน์อัปโหลดเอกสาร: แยกข้อความ (OCR ถ้าจำเป็น) → ตัดเป็นช่วง → เวกเตอร์ → เก็บใน Qdrant
 * ทำงานเบื้องหลังหลังตอบ HTTP ไปแล้ว สถานะอัปเดตผ่าน SSE
 */
export async function ingestDocument(
  documentId: string,
  workspaceId: string,
  buf: Buffer,
  filename: string,
  mimeType: string
): Promise<void> {
  const push = async (status: "PROCESSING" | "READY" | "FAILED", extra: { chunkCount?: number; error?: string | null } = {}) => {
    const doc = await prisma.document.update({ where: { id: documentId }, data: { status, ...extra } });
    broadcast(workspaceId, "document", {
      id: doc.id,
      filename: doc.filename,
      status: doc.status,
      chunkCount: doc.chunkCount,
      error: doc.error,
    });
  };

  try {
    await push("PROCESSING");

    const { text, note, viaOcr } = await extractText(buf, filename, mimeType);
    if (!text) {
      await push("FAILED", { error: note || "ไม่พบข้อความในไฟล์" });
      await logEvent(workspaceId, "kb.failed", `${filename}: ${note || "ไม่พบข้อความ"}`);
      return;
    }
    if (viaOcr) await logEvent(workspaceId, "kb.ocr", `${filename} — ใช้ OCR อ่านข้อความ`);

    const pieces = chunkTextForBlocks(text);
    if (!pieces.length) {
      await push("FAILED", { error: "ตัดข้อความเป็นช่วงไม่ได้" });
      return;
    }

    // ทั้งไฟล์ถือเป็นบล็อกเดียว แต่ละ chunk เป็นชิ้นส่วนของบล็อกนั้น
    // เก็บ parentId/partIndex ไว้เพื่อขยายกลับเป็นบล็อกเดิมตอนค้นเจอ
    const parentId = parentIdOf(documentId, filename, 0);
    const payloads: ChunkPayload[] = pieces.map((piece, i) => ({
      workspaceId,
      documentId,
      filename,
      chunkIndex: i,
      text: piece,
      parentId,
      partIndex: i,
      partCount: pieces.length,
      label: pieces.length > 1 ? `ส่วนที่ ${i + 1}/${pieces.length}` : "ทั้งไฟล์",
    }));

    const vectors = await embed(pieces);
    await upsertChunks(vectors, payloads);

    await push("READY", { chunkCount: pieces.length, error: null });
    await logEvent(workspaceId, "kb.ready", `${filename} — ${pieces.length} ช่วงข้อความ${viaOcr ? " (ผ่าน OCR)" : ""}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await push("FAILED", { error: msg.slice(0, 500) });
    await logEvent(workspaceId, "kb.failed", `${filename}: ${msg.slice(0, 200)}`);
  }
}

export async function removeDocument(workspaceId: string, documentId: string): Promise<void> {
  await deleteDocument(workspaceId, documentId).catch(() => undefined);
  await prisma.document.deleteMany({ where: { id: documentId, workspaceId } });
}
