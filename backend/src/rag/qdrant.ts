import crypto from "crypto";
import { env } from "../env";

export interface ChunkPayload {
  workspaceId: string;
  documentId: string;
  filename: string;
  chunkIndex: number;
  text: string;
  /** id ของบล็อกแม่ — ใช้รวม chunk ลูกกลับเป็นบล็อกเดิมหลังค้นเจอ */
  parentId?: string;
  partIndex?: number;
  partCount?: number;
  label?: string;
}

export interface Hit {
  score: number;
  payload: ChunkPayload;
  /** คะแนนจาก reranker (ถ้ามี) */
  rerankScore?: number;
  /** ข้อความที่ขยายกลับเป็นบล็อกแม่แล้ว */
  expandedText?: string;
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(env.qdrant.apiKey ? { "api-key": env.qdrant.apiKey } : {}),
  };
}

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const res = await fetch(`${env.qdrant.url}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  if (!res.ok) throw new Error(`Qdrant ${init.method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

let ready = false;

/** สร้าง collection ถ้ายังไม่มี และทำ index ของฟิลด์ที่ใช้กรอง */
export async function ensureCollection(): Promise<void> {
  if (ready) return;
  const name = env.qdrant.collection;
  const info = await fetch(`${env.qdrant.url}/collections/${name}`, { headers: headers() });
  if (info.status === 404) {
    await call(`/collections/${name}`, {
      method: "PUT",
      body: JSON.stringify({ vectors: { size: env.embedding.dim, distance: "Cosine" } }),
    });
    for (const field of ["workspaceId", "documentId", "parentId"]) {
      await call(`/collections/${name}/index?wait=true`, {
        method: "PUT",
        body: JSON.stringify({ field_name: field, field_schema: "keyword" }),
      }).catch(() => undefined);
    }
  } else if (info.ok) {
    const json = (await info.json()) as { result?: { config?: { params?: { vectors?: { size?: number } } } } };
    const size = json.result?.config?.params?.vectors?.size;
    if (size && size !== env.embedding.dim) {
      throw new Error(
        `Qdrant collection "${name}" มีขนาดเวกเตอร์ ${size} แต่ EMBEDDING_DIM=${env.embedding.dim} — ` +
          `ให้แก้ EMBEDDING_DIM ให้ตรง หรือเปลี่ยน QDRANT_COLLECTION เป็นชื่อใหม่`
      );
    }
  } else {
    throw new Error(`ติดต่อ Qdrant ไม่ได้: ${info.status}`);
  }
  ready = true;
}

export async function upsertChunks(vectors: number[][], payloads: ChunkPayload[]): Promise<void> {
  await ensureCollection();
  const points = payloads.map((payload, i) => ({ id: crypto.randomUUID(), vector: vectors[i], payload }));
  const BATCH = 64;
  for (let i = 0; i < points.length; i += BATCH) {
    await call(`/collections/${env.qdrant.collection}/points?wait=true`, {
      method: "PUT",
      body: JSON.stringify({ points: points.slice(i, i + BATCH) }),
    });
  }
}

export async function search(workspaceId: string, vector: number[], topK: number): Promise<Hit[]> {
  await ensureCollection();
  const json = await call<{ result: Array<{ score: number; payload: ChunkPayload }> }>(
    `/collections/${env.qdrant.collection}/points/search`,
    {
      method: "POST",
      body: JSON.stringify({
        vector,
        limit: topK,
        with_payload: true,
        filter: { must: [{ key: "workspaceId", match: { value: workspaceId } }] },
      }),
    }
  );
  return (json.result || []).map((r) => ({ score: r.score, payload: r.payload }));
}

/**
 * ดึง chunk ทุกชิ้นที่อยู่ในบล็อกแม่เดียวกัน
 * ใช้ตอนขยาย chunk ลูกกลับเป็นบล็อกเดิม เพื่อไม่ให้เงื่อนไขหรือข้อยกเว้นที่อยู่ท่อนถัดไปขาดหาย
 */
export async function fetchByParentIds(workspaceId: string, parentIds: string[]): Promise<ChunkPayload[]> {
  if (!parentIds.length) return [];
  await ensureCollection();
  const json = await call<{ result: { points: Array<{ payload: ChunkPayload }> } }>(
    `/collections/${env.qdrant.collection}/points/scroll`,
    {
      method: "POST",
      body: JSON.stringify({
        limit: 200,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [
            { key: "workspaceId", match: { value: workspaceId } },
            { key: "parentId", match: { any: parentIds } },
          ],
        },
      }),
    }
  );
  return (json.result?.points || []).map((p) => p.payload);
}

export async function deleteDocument(workspaceId: string, documentId: string): Promise<void> {
  await ensureCollection();
  await call(`/collections/${env.qdrant.collection}/points/delete?wait=true`, {
    method: "POST",
    body: JSON.stringify({
      filter: {
        must: [
          { key: "workspaceId", match: { value: workspaceId } },
          { key: "documentId", match: { value: documentId } },
        ],
      },
    }),
  });
}

export async function health(): Promise<boolean> {
  try {
    const res = await fetch(`${env.qdrant.url}/healthz`, { headers: headers(), signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}
