import crypto from "crypto";

function str(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`ต้องตั้งค่า environment variable: ${name}`);
  }
  return v;
}
function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) throw new Error(`${name} ต้องเป็นตัวเลข`);
  return n;
}
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

const embeddingBase = process.env.EMBEDDING_BASE_URL || "";
const llmBase = process.env.LLM_BASE_URL || "";

export const env = {
  nodeEnv: str("NODE_ENV", "development"),
  port: num("PORT", 4000),
  databaseUrl: str("DATABASE_URL"),

  /** ใช้เซ็น JWT — ต้องตั้งค่าจริงบน production */
  jwtSecret: str("JWT_SECRET", "dev-only-change-me"),
  /** คีย์เข้ารหัส token ของแต่ละช่องทาง (hex 64 ตัว = 32 ไบต์) */
  encryptionKey: str("ENCRYPTION_KEY", "0".repeat(64)),
  cookieSecure: bool("COOKIE_SECURE", false),

  /** URL ที่ผู้ใช้เอาไปวางเป็น webhook ในแต่ละแพลตฟอร์ม */
  publicUrl: str("PUBLIC_URL", "http://localhost:8080"),

  qdrant: {
    url: str("QDRANT_URL", "http://qdrant:6333"),
    apiKey: process.env.QDRANT_API_KEY || "",
    collection: str("QDRANT_COLLECTION", "hub_chunks"),
  },

  embedding: {
    /** "openai" = เรียก endpoint ที่เข้ากันได้กับ OpenAI (vLLM, Ollama, TEI, OpenAI)
     *  "demo"   = คำนวณเวกเตอร์ในเครื่องแบบง่าย ใช้ลองระบบก่อนต่อ GPU จริง */
    provider: (process.env.EMBEDDING_PROVIDER || (embeddingBase ? "openai" : "demo")) as "openai" | "demo",
    baseUrl: embeddingBase.replace(/\/$/, ""),
    apiKey: process.env.EMBEDDING_API_KEY || "",
    model: str("EMBEDDING_MODEL", "bge-m3"),
    dim: num("EMBEDDING_DIM", 1024),
  },

  /**
   * คะแนนขั้นต่ำเริ่มต้นที่ยอมให้บอทตอบ
   * โมเดลจริงให้คะแนนความใกล้เคียง 0.6–0.9 ส่วนโหมด demo ได้แค่ราว 0.1
   * จึงต้องใช้เกณฑ์คนละระดับ ไม่งั้นโหมด demo จะส่งต่อพนักงานทุกคำถาม
   */
  get defaultMinScore(): number {
    const v = process.env.DEFAULT_MIN_SCORE;
    if (v) return Number(v);
    return this.embedding.provider === "demo" ? 0.05 : 0.35;
  },

  llm: {
    /** "openai"     = เรียก /chat/completions ของ endpoint ที่ตั้งไว้
     *  "extractive" = ไม่เรียก LLM ตอบด้วยข้อความจากเอกสารที่ใกล้เคียงที่สุด */
    provider: (process.env.LLM_PROVIDER || (llmBase ? "openai" : "extractive")) as "openai" | "extractive",
    baseUrl: llmBase.replace(/\/$/, ""),
    apiKey: process.env.LLM_API_KEY || "",
    model: str("LLM_MODEL", "gpt-oss-120b"),
    maxTokens: num("LLM_MAX_TOKENS", 512),
    temperature: num("LLM_TEMPERATURE", 0.2),
    timeoutMs: num("LLM_TIMEOUT_MS", 60000),
  },

  upload: {
    maxBytes: num("UPLOAD_MAX_BYTES", 20 * 1024 * 1024),
    /** chunk ใหญ่ = ชิ้นน้อย = เรียก embed น้อย = อัปโหลดเร็ว (ค่าเดียวกับที่ Bingsu ใช้) */
    chunkSize: num("TEXT_CHUNK_SIZE", 2800),
    /** จำนวน chunk ที่ส่ง embed พร้อมกันต่อชุด และจำนวนชุดที่ยิงขนานกัน */
    embedBatchSize: num("EMBEDDING_BATCH_SIZE", 32),
    embedParallelBatches: num("EMBEDDING_PARALLEL_BATCHES", 2),
  },

  /** บริการ OCR ภายนอกสำหรับ PDF สแกน (ใช้ Service/Ocr ของ Bingsu ได้เลย) */
  ocr: {
    url: (process.env.OCR_API_URL || "").replace(/\/$/, ""),
    lang: str("OCR_LANG", "th"),
    maxPages: num("OCR_MAX_PAGES", 30),
    dpi: num("OCR_DPI", 200),
    useAngleCls: bool("OCR_USE_ANGLE_CLS", true),
    /** ถ้าดึงข้อความจาก PDF ได้น้อยกว่านี้ ถือว่าเป็นไฟล์สแกน ต้องส่งไป OCR */
    minTextChars: num("OCR_MIN_TEXT_CHARS", 200),
    timeoutMs: num("OCR_TIMEOUT_MS", 300000),
  },

  /** reranker ภายนอก — เรียงผลค้นหาใหม่ให้ตรงคำถามกว่า vector score */
  rerank: {
    enabled: bool("RERANK_ENABLED", Boolean(process.env.RERANK_URL)),
    url: process.env.RERANK_URL || "",
    apiKey: process.env.RERANK_API_KEY || "",
    model: process.env.RERANK_MODEL || "",
    timeoutMs: num("RERANK_TIMEOUT_MS", 10000),
    /** ดึงผู้สมัครจาก Qdrant มากกว่า topK เท่านี้ เพื่อให้ reranker มีของให้เลือก */
    candidateMultiplier: num("RERANK_CANDIDATE_MULTIPLIER", 3),
  },

  rag: {
    /** จำนวนคำค้นที่ขยายจากคำถามเดียว (คำพ้องความหมาย) */
    queryVariantLimit: num("RAG_QUERY_VARIANT_LIMIT", 4),
    /** ขยาย chunk ลูกกลับเป็นบล็อกแม่ กันเงื่อนไข/ข้อยกเว้นที่อยู่ท่อนถัดไปขาดหาย */
    parentExpansion: bool("PARENT_CHUNK_EXPANSION", true),
    /**
     * เพดานความยาวของบล็อกแม่ที่ยอมรวมกลับ (กัน context บวมเกินหน้าต่างของโมเดล)
     * ต้องมากกว่า TEXT_CHUNK_SIZE ไม่งั้นจะไม่มีทางรวมได้เลย
     * เพราะบล็อกจะถูกหั่นก็ต่อเมื่อมันยาวเกิน chunk อยู่แล้ว
     */
    parentMaxChars: num("PARENT_CHUNK_MAX_CHARS", Math.max(6000, num("TEXT_CHUNK_SIZE", 2800) * 2)),
    /** คำพ้องความหมายเพิ่มเติม รูปแบบ JSON: {"คำ":["คำพ้อง1","คำพ้อง2"]} */
    synonyms: parseJson(process.env.RAG_QUERY_SYNONYMS),
  },
};

function parseJson(value: string | undefined): Record<string, string[]> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string[]>) : {};
  } catch {
    console.warn("[env] RAG_QUERY_SYNONYMS ไม่ใช่ JSON ที่ถูกต้อง — ข้ามค่านี้");
    return {};
  }
}

export function assertProductionSafety(): string[] {
  const warn: string[] = [];
  if (env.jwtSecret === "dev-only-change-me") warn.push("JWT_SECRET ยังเป็นค่าเริ่มต้น — ต้องเปลี่ยนก่อนใช้งานจริง");
  if (env.encryptionKey === "0".repeat(64)) warn.push("ENCRYPTION_KEY ยังเป็นค่าเริ่มต้น — token ของช่องทางจะถูกเข้ารหัสด้วยคีย์ที่ใครก็เดาได้");
  if (env.embedding.provider === "demo") warn.push("EMBEDDING_PROVIDER=demo — ใช้เวกเตอร์จำลอง คุณภาพการค้นหาต่ำ ให้ตั้ง EMBEDDING_BASE_URL ไปที่ embedding server จริง");
  if (env.llm.provider === "extractive") warn.push("LLM_BASE_URL ยังไม่ได้ตั้ง — บอทจะตอบด้วยข้อความดิบจากเอกสาร ไม่ได้เรียบเรียงใหม่");
  if (env.nodeEnv === "production" && !env.cookieSecure) warn.push("COOKIE_SECURE=0 บน production — cookie จะส่งผ่าน http ได้");
  if (env.rag.parentExpansion && env.rag.parentMaxChars <= env.upload.chunkSize) {
    warn.push(
      `PARENT_CHUNK_MAX_CHARS (${env.rag.parentMaxChars}) ไม่มากกว่า TEXT_CHUNK_SIZE (${env.upload.chunkSize}) — ` +
        "การรวมช่วงข้อความกลับเป็นบล็อกเดิมจะไม่ทำงาน"
    );
  }
  return warn;
}

export function encryptionKeyBuffer(): Buffer {
  const k = env.encryptionKey;
  if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
  // ยอมรับ passphrase ธรรมดาด้วย โดย derive เป็น 32 ไบต์
  return crypto.createHash("sha256").update(k).digest();
}
