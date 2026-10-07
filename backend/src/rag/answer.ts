import { env } from "../env";
import { embedOne } from "./embed";
import { Hit, fetchByParentIds, search } from "./qdrant";
import { rerank } from "./rerank";

export interface BotConfig {
  persona: string;
  fallback: string;
  minScore: number;
  topK: number;
  handoverTopics: string[];
}

export interface AnswerResult {
  kind: "answered" | "handover";
  text: string;
  sources: string[];
  reason?: "topic" | "no_match" | "error";
  score?: number;
}

/** หัวข้อที่ตั้งไว้ว่าต้องให้คนดูแลเสมอ เช่น ร้องเรียน คืนเงิน */
export function matchHandoverTopic(text: string, topics: string[]): string | null {
  const lower = text.toLowerCase();
  for (const t of topics) {
    const k = t.trim();
    if (k && lower.includes(k.toLowerCase())) return k;
  }
  return null;
}

/* ---------- ขยายคำค้น (พอร์ตแนวคิดจาก Bingsu: expandQueryVariants) ---------- */

const normalizeQuery = (s: string) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

/** คำที่คนพิมพ์หลายแบบแต่หมายถึงเรื่องเดียวกัน เพิ่มได้ผ่าน RAG_QUERY_SYNONYMS */
const DEFAULT_SYNONYMS: Record<string, string[]> = {
  ราคา: ["ค่าบริการ", "อัตราค่าบริการ", "เท่าไหร่", "กี่บาท"],
  ค่าบริการ: ["ราคา", "อัตราค่าบริการ", "ค่าใช้จ่าย"],
  ค่าส่ง: ["ค่าจัดส่ง", "ค่าขนส่ง"],
  จัดส่ง: ["ส่งของ", "ขนส่ง", "การจัดส่ง"],
  คืนสินค้า: ["เปลี่ยนสินค้า", "คืนของ", "เคลม"],
  สต็อก: ["ของเหลือ", "มีของไหม", "คงเหลือ"],
  โปรโมชัน: ["ส่วนลด", "โปร", "ลดราคา"],
};

const OVERVIEW_FALLBACK = "สรุปเนื้อหาโดยรวมของเอกสาร";
const OVERVIEW_PATTERNS = [
  /เกี่ยวกับอะไร/,
  /สรุป(ให้)?(หน่อย)?/,
  /มีอะไรบ้าง/,
  /เรื่องอะไร/,
  /เนื้อหาโดยรวม/,
];

function isOverviewQuery(q: string): boolean {
  const n = normalizeQuery(q);
  if (!n || n.length > 140) return false;
  return OVERVIEW_PATTERNS.some((re) => re.test(n));
}

export function expandQueryVariants(query: string): string[] {
  const normalized = normalizeQuery(query);
  if (!normalized) return [];
  const variants = new Set<string>([normalized]);
  if (isOverviewQuery(normalized)) variants.add(OVERVIEW_FALLBACK);

  // แต่ละ entry คือกลุ่มคำที่มีความหมายเดียวกัน
  // ถ้าคำถามมีสมาชิกใดในกลุ่ม ให้เพิ่มสมาชิกที่เหลือเป็นคำค้นด้วย (สองทิศทาง)
  const dict = { ...DEFAULT_SYNONYMS, ...env.rag.synonyms };
  for (const [term, synonyms] of Object.entries(dict)) {
    const group = [normalizeQuery(term), ...(synonyms || []).map(normalizeQuery)].filter(Boolean);
    if (group.length < 2) continue;
    const present = group.filter((g) => normalized.includes(g));
    if (!present.length) continue;
    for (const member of group) {
      for (const p of present) {
        if (p !== member) variants.add(normalized.replaceAll(p, member));
      }
    }
  }
  return Array.from(variants).slice(0, Math.max(1, env.rag.queryVariantLimit));
}

/* ---------- ค้นหา ---------- */

const keyOf = (h: Hit) => `${h.payload.documentId}#${h.payload.chunkIndex}`;

/**
 * ขยาย chunk ลูกกลับเป็นบล็อกแม่
 * กันกรณีที่เงื่อนไขหรือข้อยกเว้นอยู่คนละ chunk กับใจความหลัก
 */
async function expandParents(workspaceId: string, ranked: Hit[]): Promise<Hit[]> {
  if (!env.rag.parentExpansion || !ranked.length) return ranked;

  const needed = ranked
    .filter((h) => h.payload.parentId && (h.payload.partCount || 1) > 1)
    .map((h) => h.payload.parentId as string);
  const parentIds = Array.from(new Set(needed)).slice(0, 8);
  if (!parentIds.length) return ranked;

  let siblings: Awaited<ReturnType<typeof fetchByParentIds>>;
  try {
    siblings = await fetchByParentIds(workspaceId, parentIds);
  } catch (err) {
    console.warn("[rag] ดึงบล็อกแม่ไม่สำเร็จ:", err instanceof Error ? err.message : err);
    return ranked;
  }

  const byParent = new Map<string, typeof siblings>();
  for (const s of siblings) {
    if (!s.parentId) continue;
    const list = byParent.get(s.parentId) || [];
    list.push(s);
    byParent.set(s.parentId, list);
  }

  return ranked.map((hit) => {
    const pid = hit.payload.parentId;
    if (!pid) return hit;
    const group = byParent.get(pid);
    if (!group || group.length < 2) return hit;
    const merged = group
      .slice()
      .sort((a, b) => (a.partIndex ?? 0) - (b.partIndex ?? 0))
      .map((p) => p.text)
      .join("\n\n");
    // บล็อกแม่ที่ยาวเกินกำหนดไม่ขยาย กัน context บวมจนเกินหน้าต่างของโมเดล
    if (merged.length > env.rag.parentMaxChars) return hit;
    return { ...hit, expandedText: merged };
  });
}

/** ค้นด้วยคำค้นหลายแบบ รวมผล เรียงใหม่ แล้วขยายเป็นบล็อกแม่ */
export async function retrieve(workspaceId: string, question: string, cfg: BotConfig): Promise<Hit[]> {
  const variants = expandQueryVariants(question);
  const candidateCount = Math.max(cfg.topK, cfg.topK * (env.rerank.enabled ? env.rerank.candidateMultiplier : 1));

  const merged = new Map<string, Hit>();
  for (const v of variants) {
    const vector = await embedOne(v);
    const hits = await search(workspaceId, vector, candidateCount);
    for (const h of hits) {
      const k = keyOf(h);
      const prev = merged.get(k);
      // คำค้นหลายแบบอาจเจอ chunk เดียวกัน เก็บคะแนนที่ดีที่สุดไว้
      if (!prev || h.score > prev.score) merged.set(k, h);
    }
  }

  const candidates = Array.from(merged.values()).sort((a, b) => b.score - a.score);
  if (!candidates.length) return [];

  const reranked = await rerank(question, candidates.slice(0, candidateCount), cfg.topK);
  const ranked = reranked || candidates.slice(0, cfg.topK);
  return expandParents(workspaceId, ranked);
}

/* ---------- สร้างคำตอบ ---------- */

function buildPrompt(question: string, hits: Hit[], cfg: BotConfig): { system: string; user: string } {
  const context = hits
    .map((h, i) => `[${i + 1}] (ไฟล์: ${h.payload.filename})\n${h.expandedText || h.payload.text}`)
    .join("\n\n---\n\n");
  const system = [
    cfg.persona,
    "",
    "กติกา:",
    "- ตอบโดยใช้ข้อมูลใน <context> เท่านั้น ห้ามเดาหรือแต่งข้อมูลเพิ่ม",
    "- ถ้าข้อมูลใน <context> ไม่พอจะตอบ ให้ตอบว่า NO_ANSWER คำเดียวเท่านั้น",
    "- ตอบเป็นภาษาเดียวกับคำถามของลูกค้า",
    "- ถ้าข้อมูลอยู่ในตาราง ให้อ่านหัวตารางให้ตรงคอลัมน์ก่อนตอบ",
    "- ตอบสั้น กระชับ ไม่ต้องอ้างเลขอ้างอิงหรือชื่อไฟล์ในคำตอบ",
  ].join("\n");
  const user = `<context>\n${context}\n</context>\n\nคำถามของลูกค้า: ${question}`;
  return { system, user };
}

async function callLLM(system: string, user: string): Promise<string> {
  const res = await fetch(`${env.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.llm.apiKey ? { authorization: `Bearer ${env.llm.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: env.llm.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: env.llm.maxTokens,
      temperature: env.llm.temperature,
    }),
    signal: AbortSignal.timeout(env.llm.timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM ตอบ ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = json.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("LLM ไม่ได้ส่งข้อความกลับมา");
  return text;
}

/**
 * ค้นฐานความรู้แล้วให้ LLM เรียบเรียงคำตอบ
 * ถ้าค้นไม่เจอ คะแนนต่ำกว่าเกณฑ์ หรือ LLM บอกว่าตอบไม่ได้ จะส่งต่อให้พนักงาน
 */
export async function answerQuestion(workspaceId: string, question: string, cfg: BotConfig): Promise<AnswerResult> {
  const topic = matchHandoverTopic(question, cfg.handoverTopics);
  if (topic) return { kind: "handover", text: "", sources: [], reason: "topic", score: 0 };

  let hits: Hit[];
  try {
    hits = await retrieve(workspaceId, question, cfg);
  } catch (err) {
    console.warn("[rag] ค้นหาไม่สำเร็จ:", err instanceof Error ? err.message : err);
    return { kind: "handover", text: cfg.fallback, sources: [], reason: "error" };
  }

  // กรองด้วยคะแนนจาก vector เสมอ เพื่อให้เกณฑ์ที่ผู้ใช้ตั้งไว้มีความหมายคงที่
  // (คะแนนจาก reranker อยู่คนละสเกลและไม่ได้มีทุกครั้ง)
  const good = hits.filter((h) => h.score >= cfg.minScore);
  if (!good.length) {
    return { kind: "handover", text: cfg.fallback, sources: [], reason: "no_match", score: hits[0]?.score ?? 0 };
  }

  const sources = [...new Set(good.map((h) => h.payload.filename))];

  if (env.llm.provider === "extractive") {
    // ไม่มี LLM — ส่งข้อความต้นฉบับที่ใกล้เคียงที่สุดกลับไป
    return { kind: "answered", text: (good[0].expandedText || good[0].payload.text).slice(0, 600), sources, score: good[0].score };
  }

  try {
    const { system, user } = buildPrompt(question, good, cfg);
    const text = await callLLM(system, user);
    if (/^no[_ ]?answer/i.test(text)) {
      return { kind: "handover", text: cfg.fallback, sources: [], reason: "no_match", score: good[0].score };
    }
    return { kind: "answered", text, sources, score: good[0].score };
  } catch (err) {
    console.warn("[rag] LLM ใช้ไม่ได้:", err instanceof Error ? err.message : err);
    return { kind: "handover", text: cfg.fallback, sources: [], reason: "error" };
  }
}
