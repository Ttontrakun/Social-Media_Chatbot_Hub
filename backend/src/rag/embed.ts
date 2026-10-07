import crypto from "crypto";
import { env } from "../env";

/**
 * เวกเตอร์จำลองสำหรับโหมด demo
 * ใช้ตัวอักษรต่อเนื่อง 3 ตัว (character trigram) แฮชลงช่องเวกเตอร์
 * ใช้ได้กับภาษาไทยที่ไม่มีช่องว่างระหว่างคำ แต่คุณภาพต่ำกว่าโมเดลจริงมาก
 */
function demoEmbed(text: string, dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  if (!s) return v;
  const grams: string[] = [];
  for (let i = 0; i < s.length - 2; i++) grams.push(s.slice(i, i + 3));
  for (const w of s.split(" ")) if (w.length > 1) grams.push("w:" + w);
  for (const g of grams) {
    const h = crypto.createHash("md5").update(g).digest();
    const slot = h.readUInt32BE(0) % dim;
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    v[slot] += sign;
  }
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  return norm > 0 ? v.map((x) => x / norm) : v;
}

async function openaiEmbed(texts: string[]): Promise<number[][]> {
  if (!env.embedding.baseUrl) throw new Error("ยังไม่ได้ตั้งค่า EMBEDDING_BASE_URL");
  const res = await fetch(`${env.embedding.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.embedding.apiKey ? { authorization: `Bearer ${env.embedding.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: env.embedding.model, input: texts, encoding_format: "float" }),
    signal: AbortSignal.timeout(env.llm.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`embedding server ตอบ ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { data?: Array<{ embedding: number[]; index?: number }> };
  if (!json.data || !json.data.length) throw new Error("embedding server ไม่ได้ส่งเวกเตอร์กลับมา");
  const sorted = [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const out = sorted.map((d) => d.embedding);
  if (out.length !== texts.length) throw new Error(`จำนวนเวกเตอร์ (${out.length}) ไม่ตรงกับจำนวนข้อความ (${texts.length})`);
  if (out[0].length !== env.embedding.dim) {
    throw new Error(`EMBEDDING_DIM ตั้งไว้ ${env.embedding.dim} แต่โมเดลคืนมา ${out[0].length} — แก้ค่าใน .env ให้ตรงกัน`);
  }
  return out;
}

/**
 * แปลงข้อความเป็นเวกเตอร์
 * ส่งเป็นชุด (batch) และยิงหลายชุดขนานกัน เพื่อให้อัปโหลดเอกสารใหญ่ไม่ช้าเกินไป
 * วิธีเดียวกับที่ Bingsu ใช้ใน indexDocumentChunks
 */
export async function embed(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
  if (!texts.length) return [];
  if (env.embedding.provider === "demo") {
    const vectors = texts.map((t) => demoEmbed(t, env.embedding.dim));
    onProgress?.(texts.length, texts.length);
    return vectors;
  }

  const batch = Math.max(1, env.upload.embedBatchSize);
  const parallel = Math.max(1, env.upload.embedParallelBatches);
  const out: number[][] = [];

  for (let i = 0; i < texts.length; i += batch * parallel) {
    const jobs: Promise<number[][]>[] = [];
    for (let p = 0; p < parallel; p++) {
      const start = i + p * batch;
      if (start >= texts.length) break;
      jobs.push(openaiEmbed(texts.slice(start, Math.min(start + batch, texts.length))));
    }
    const results = await Promise.all(jobs);
    for (const v of results) out.push(...v);
    onProgress?.(out.length, texts.length);
  }
  return out;
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}
