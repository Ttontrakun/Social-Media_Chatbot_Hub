import { env } from "../env";

export interface Chunk {
  index: number;
  text: string;
}

/*
 * การตัด chunk แบบรู้จักโครงสร้างเอกสาร
 * พอร์ตมาจาก Bingsu_core (Backend/server/services/text.js — chunkTextForBlocks)
 * หลักการ:
 *  - ไม่ตัดกลางตาราง Markdown ถ้าตารางใหญ่เกินจะหั่นตามแถวและใส่หัวตารางซ้ำทุกส่วน
 *  - หัวข้อ (markdown heading) ต้องอยู่กับเนื้อหาของมัน ไม่ค้างท้าย chunk
 *  - จัดกลุ่มย่อหน้าแบบ greedy ให้พอดี chunk โดยตัดที่ขอบบล็อก ไม่ตัดกลางประโยค
 * สำคัญกับเอกสารไทยที่มีตารางราคา/ตารางอัตราค่าบริการ ซึ่งถ้าตัดกลางจะตอบผิด
 */

const isMarkdownTableLine = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isTableSeparatorLine = (line: string): boolean =>
  /^\s*\|?[\s:|-]*-{3,}[\s:|-]*\|?\s*$/.test(line) && line.includes("-");

/** หั่นตารางใหญ่ตามแถว ใส่หัวตารางซ้ำทุกส่วน เพื่อให้ทุก chunk ยังรู้ว่าคอลัมน์ไหนคืออะไร */
function splitTableByRows(tableText: string, size: number): string[] {
  const rows = tableText.split("\n").filter((l) => l.trim());
  if (rows.length < 2) return [tableText];
  const hasSep = Boolean(rows[1] && isTableSeparatorLine(rows[1]));
  const headerBlock = hasSep ? `${rows[0]}\n${rows[1]}` : rows[0];
  const bodyRows = rows.slice(hasSep ? 2 : 1);

  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = headerBlock.length;
  for (const row of bodyRows) {
    if (current.length > 0 && currentLen + row.length + 1 > size) {
      parts.push([headerBlock, ...current].join("\n"));
      current = [];
      currentLen = headerBlock.length;
    }
    current.push(row);
    currentLen += row.length + 1;
  }
  if (current.length) parts.push([headerBlock, ...current].join("\n"));
  return parts.length ? parts : [tableText];
}

/** หั่นย่อหน้ายาวที่ขอบบรรทัด (ไม่ตัดกลางบรรทัดถ้าเลี่ยงได้) */
function splitLongText(textBlock: string, size: number): string[] {
  if (textBlock.length <= size) return [textBlock];
  const out: string[] = [];
  let start = 0;
  while (start < textBlock.length) {
    let end = Math.min(start + size, textBlock.length);
    if (end < textBlock.length) {
      const nl = textBlock.lastIndexOf("\n", end);
      if (nl > start + 200) end = nl;
    }
    const slice = textBlock.slice(start, end).trim();
    if (slice) out.push(slice);
    start = end;
  }
  return out;
}

const isHeadingUnit = (u: string): boolean => {
  const t = u.trim();
  return /^#{1,6}\s/.test(t) && t.split("\n").length <= 2;
};

export function chunkTextForBlocks(text: string, chunkSize = env.upload.chunkSize): string[] {
  const normalized = (text || "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= chunkSize) return [normalized];
  const size = Math.max(400, Number(chunkSize) || env.upload.chunkSize);

  // 1) แยกเป็น segment: บล็อกตาราง (ห้ามตัดกลาง) กับบล็อกข้อความ
  const lines = normalized.split("\n");
  const segments: Array<{ type: "table" | "text"; text: string }> = [];
  let buffer: string[] = [];
  let bufferType: "table" | "text" | null = null;
  const flush = () => {
    if (!buffer.length || !bufferType) return;
    segments.push({ type: bufferType, text: buffer.join("\n").trim() });
    buffer = [];
    bufferType = null;
  };
  for (const line of lines) {
    const type: "table" | "text" = isMarkdownTableLine(line) ? "table" : "text";
    if (bufferType && type !== bufferType) flush();
    bufferType = type;
    buffer.push(line);
  }
  flush();

  // 2) กาง segment ที่ใหญ่เกิน chunk ออกเป็นหน่วยย่อย
  const units: string[] = [];
  for (const seg of segments) {
    if (!seg.text) continue;
    if (seg.type === "table" && seg.text.length > size) {
      splitTableByRows(seg.text, size).forEach((t) => units.push(t));
    } else if (seg.type === "text" && seg.text.length > size) {
      seg.text
        .split(/\n{2,}/)
        .flatMap((para) => splitLongText(para.trim(), size))
        .filter(Boolean)
        .forEach((t) => units.push(t));
    } else {
      units.push(seg.text);
    }
  }

  // 3) แพ็กหน่วยย่อยเข้า chunk แบบ greedy (ไม่หั่นกลางหน่วย)
  const chunks: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  const pushCurrent = () => {
    const joined = current.join("\n\n").trim();
    if (joined) chunks.push(joined);
    current = [];
    currentLen = 0;
  };

  for (const unit of units) {
    const addLen = unit.length + 2;
    if (currentLen > 0 && currentLen + addLen > size) {
      // ย้ายหัวข้อที่ค้างท้าย chunk ไปเริ่ม chunk ใหม่พร้อมเนื้อหาถัดไป
      const carry: string[] = [];
      while (current.length > 0 && isHeadingUnit(current[current.length - 1])) {
        carry.unshift(current.pop() as string);
      }
      pushCurrent();
      if (carry.length > 0) {
        current = carry;
        currentLen = carry.reduce((sum, u) => sum + u.length + 2, 0);
      }
    }
    current.push(unit);
    currentLen += addLen;
  }
  pushCurrent();
  return chunks.length ? chunks : [normalized];
}

/** รูปแบบเดิมที่ routes ใช้อยู่ — คืนพร้อมลำดับ */
export function chunkText(text: string, size = env.upload.chunkSize): Chunk[] {
  return chunkTextForBlocks(text, size).map((t, index) => ({ index, text: t }));
}
