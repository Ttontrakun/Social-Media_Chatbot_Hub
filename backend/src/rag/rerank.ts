import { env } from "../env";
import { Hit } from "./qdrant";

/*
 * เรียงลำดับผลค้นหาใหม่ด้วย reranker ภายนอก
 * พอร์ตมาจาก Bingsu_core (Backend/server/services/rerank.js)
 * vector score บอกแค่ความใกล้เคียงเชิงความหมาย reranker จะดูว่า "ตอบคำถามนี้ได้จริงไหม"
 * ถ้าไม่ได้ตั้งค่าหรือเรียกไม่สำเร็จ จะคืน null แล้วระบบใช้ลำดับเดิมจาก Qdrant ต่อไป
 */
export async function rerank(query: string, hits: Hit[], topK: number): Promise<Hit[] | null> {
  if (!env.rerank.enabled || !env.rerank.url || !env.rerank.model) return null;
  if (!query || !hits.length) return null;

  try {
    const res = await fetch(env.rerank.url.replace(/\/+$/, ""), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(env.rerank.apiKey ? { authorization: `Bearer ${env.rerank.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: env.rerank.model,
        query,
        documents: hits.map((h) => h.payload.text),
        top_n: Math.max(1, Math.min(topK, hits.length)),
        return_documents: false,
      }),
      signal: AbortSignal.timeout(env.rerank.timeoutMs),
    });
    if (!res.ok) throw new Error(`reranker ตอบ ${res.status}`);

    const json = (await res.json()) as Record<string, unknown>;
    const list = [json.results, json.data, json.ranked_documents, json.reranked].find((x) => Array.isArray(x)) as
      | Array<Record<string, unknown>>
      | undefined;
    if (!list || !list.length) return null;

    const seen = new Set<number>();
    const ranked: Hit[] = [];
    for (const item of list) {
      const index = Number(item.index);
      if (!Number.isInteger(index) || index < 0 || index >= hits.length || seen.has(index)) continue;
      seen.add(index);
      const score = Number(item.relevance_score ?? item.score ?? item.relevanceScore ?? item.similarity ?? 0);
      ranked.push({ ...hits[index], rerankScore: Number.isFinite(score) ? score : 0 });
    }
    if (!ranked.length) return null;
    return ranked.sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0)).slice(0, topK);
  } catch (err) {
    console.warn("[rag] reranker ใช้ไม่ได้ ใช้ลำดับเดิมจาก Qdrant แทน:", err instanceof Error ? err.message : err);
    return null;
  }
}
