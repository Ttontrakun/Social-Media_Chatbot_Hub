import { env } from "../env";

/*
 * เรียกบริการ OCR ภายนอกสำหรับ PDF ที่เป็นภาพสแกน
 * พอร์ตมาจาก Bingsu_core (Backend/Service/Ocr/client.js)
 * ตั้ง OCR_API_URL ชี้ไปที่บริการ OCR (เช่น Service/Ocr ของ Bingsu ที่รัน PaddleOCR ภาษาไทย)
 * ถ้าไม่ตั้งค่า ระบบจะข้าม OCR และแจ้งว่าอ่านไฟล์ไม่ได้
 */

/** ข้อความที่ดึงจาก PDF น้อยเกินไป แปลว่าน่าจะเป็นไฟล์สแกน ต้องส่งไป OCR */
export function shouldRunOcr(text: string): boolean {
  if (!env.ocr.url) return false;
  const normalized = String(text || "").replace(/\s+/g, "").trim();
  return normalized.length < env.ocr.minTextChars;
}

export interface OcrResult {
  text: string;
  pages?: number;
}

export async function runOcr(buf: Buffer, filename: string, contentType: string): Promise<OcrResult> {
  if (!env.ocr.url) throw new Error("ยังไม่ได้ตั้งค่า OCR_API_URL");

  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(buf)], { type: contentType || "application/pdf" }), filename || "document.pdf");
  form.append("lang", env.ocr.lang);
  form.append("max_pages", String(env.ocr.maxPages));
  form.append("dpi", String(env.ocr.dpi));
  form.append("use_angle_cls", String(env.ocr.useAngleCls));

  const res = await fetch(`${env.ocr.url}/api/ocr/extract`, {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(env.ocr.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OCR ตอบ ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    text?: string;
    pages?: Array<{ text?: string }> | number;
    result?: { text?: string };
  };
  // รองรับได้ทั้งรูปแบบที่คืน text ตรง ๆ และรูปแบบที่คืนเป็นรายหน้า
  let text = json.text || json.result?.text || "";
  if (!text && Array.isArray(json.pages)) {
    text = json.pages.map((p) => p?.text || "").join("\n\n");
  }
  return {
    text: text.trim(),
    pages: Array.isArray(json.pages) ? json.pages.length : typeof json.pages === "number" ? json.pages : undefined,
  };
}
