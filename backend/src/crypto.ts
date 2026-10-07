import crypto from "crypto";
import { encryptionKeyBuffer } from "./env";

/** เข้ารหัสข้อมูลลับ (access token, channel secret) ก่อนเก็บลงฐานข้อมูล */
export function encryptJson(value: unknown): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKeyBuffer(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(".");
}

export function decryptJson<T = Record<string, string>>(blob: string | null): T | null {
  if (!blob) return null;
  const parts = blob.split(".");
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64"));
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKeyBuffer(), iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(out.toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** LINE: HMAC-SHA256 ของ raw body เทียบกับ header x-line-signature (base64) */
export function verifyLineSignature(raw: Buffer, channelSecret: string, signature: string | undefined): boolean {
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", channelSecret).update(raw).digest("base64");
  return timingSafeEqual(expected, signature);
}

/** Meta: header x-hub-signature-256 = "sha256=<hex>" */
export function verifyMetaSignature(raw: Buffer, appSecret: string, signature: string | undefined): boolean {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(raw).digest("hex");
  return timingSafeEqual(expected, signature);
}

export function randomKey(prefix: string): { key: string; hash: string; prefix: string } {
  const raw = crypto.randomBytes(24).toString("base64url");
  const key = `${prefix}_${raw}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, prefix.length + 5) };
}

export function hashKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}
