import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { env } from "../env";
import { runOcr, shouldRunOcr } from "./ocr";

export interface Extracted {
  text: string;
  note?: string;
  /** true เมื่อข้อความมาจาก OCR ไม่ใช่ชั้นข้อความในไฟล์ */
  viaOcr?: boolean;
}

function cleanup(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const escapeCell = (v: unknown): string => String(v ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ").trim();

/**
 * แปลงชีตเป็นตาราง Markdown
 * สำคัญ เพราะตัวตัด chunk จะไม่ตัดกลางตาราง และถ้าตารางยาวจะใส่หัวตารางซ้ำให้ทุกส่วน
 * ทำให้คำตอบเรื่องอัตราค่าบริการหรือราคาไม่หลุดคอลัมน์
 */
function sheetToMarkdown(sheet: XLSX.WorkSheet, name: string): string {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", blankrows: false });
  if (!rows.length) return "";

  const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
  if (width === 0) return "";

  const header = rows[0].map((c, i) => escapeCell(c) || `คอลัมน์ ${i + 1}`);
  while (header.length < width) header.push(`คอลัมน์ ${header.length + 1}`);

  const lines = [`## ชีต: ${name}`, "", `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`];
  for (const row of rows.slice(1)) {
    const cells = Array.from({ length: width }, (_, i) => escapeCell(row[i]));
    if (cells.every((c) => c === "")) continue;
    lines.push(`| ${cells.join(" | ")} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * ดึงข้อความจากไฟล์ที่อัปโหลด
 * PDF ที่เป็นภาพสแกนจะถูกส่งไปบริการ OCR อัตโนมัติ (ถ้าตั้ง OCR_API_URL ไว้)
 */
export async function extractText(buf: Buffer, filename: string, mimeType: string): Promise<Extracted> {
  const ext = (filename.split(".").pop() || "").toLowerCase();

  if (ext === "pdf" || mimeType === "application/pdf") {
    // require แบบ lazy เพราะ pdf-parse อ่านไฟล์ตัวอย่างตอน import ในบางเวอร์ชัน
    const pdfParse = require("pdf-parse") as (b: Buffer) => Promise<{ text: string; numpages: number }>;
    let text = "";
    let pages = 0;
    try {
      const out = await pdfParse(buf);
      text = cleanup(out.text || "");
      pages = out.numpages;
    } catch (err) {
      text = "";
    }

    if (shouldRunOcr(text)) {
      try {
        const ocr = await runOcr(buf, filename, mimeType || "application/pdf");
        if (ocr.text) return { text: cleanup(ocr.text), viaOcr: true };
        return { text: "", note: `OCR อ่านไฟล์นี้ไม่ได้ข้อความ (${pages || ocr.pages || "?"} หน้า)` };
      } catch (err) {
        return {
          text: "",
          note: `PDF นี้เป็นภาพสแกนและส่ง OCR ไม่สำเร็จ: ${err instanceof Error ? err.message : "error"}`,
        };
      }
    }

    if (text.length < 20) {
      return {
        text: "",
        note: env.ocr.url
          ? `อ่านข้อความจาก PDF ไม่ได้ (${pages} หน้า)`
          : `อ่านข้อความจาก PDF ไม่ได้ (${pages} หน้า) — ไฟล์น่าจะเป็นภาพสแกน ตั้งค่า OCR_API_URL เพื่อให้ระบบทำ OCR ให้อัตโนมัติ`,
      };
    }
    return { text };
  }

  if (ext === "docx" || mimeType.includes("wordprocessingml")) {
    const out = await mammoth.extractRawText({ buffer: buf });
    return { text: cleanup(out.value || "") };
  }

  if (ext === "doc") {
    return { text: "", note: "ไฟล์ .doc แบบเก่าไม่รองรับ กรุณาบันทึกเป็น .docx แล้วอัปโหลดใหม่" };
  }

  if (["xlsx", "xls", "xlsm", "csv", "tsv"].includes(ext) || mimeType.includes("spreadsheet") || mimeType === "text/csv") {
    const wb = XLSX.read(buf, { type: "buffer" });
    const parts = wb.SheetNames.map((name) => sheetToMarkdown(wb.Sheets[name], name)).filter(Boolean);
    return { text: parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
  }

  if (["txt", "md", "markdown", "json", "yml", "yaml", "html", "htm"].includes(ext) || mimeType.startsWith("text/")) {
    let text = buf.toString("utf8");
    if (ext === "html" || ext === "htm") text = text.replace(/<[^>]+>/g, " ");
    return { text: cleanup(text) };
  }

  if (mimeType.startsWith("image/")) {
    if (!env.ocr.url) return { text: "", note: "ไฟล์รูปภาพต้องใช้ OCR — ตั้งค่า OCR_API_URL ก่อน" };
    try {
      const ocr = await runOcr(buf, filename, mimeType);
      if (ocr.text) return { text: cleanup(ocr.text), viaOcr: true };
      return { text: "", note: "OCR อ่านข้อความจากรูปนี้ไม่ได้" };
    } catch (err) {
      return { text: "", note: `ส่งรูปไป OCR ไม่สำเร็จ: ${err instanceof Error ? err.message : "error"}` };
    }
  }

  return { text: "", note: `ยังไม่รองรับไฟล์นามสกุล .${ext}` };
}
