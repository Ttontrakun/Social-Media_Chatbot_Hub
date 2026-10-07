import { Channel } from "../generated/prisma/client";

/** ข้อความรูปแบบกลาง — ทุกแพลตฟอร์มถูกแปลงมาเป็นรูปนี้ก่อนเข้าระบบ */
export interface InboundMessage {
  channel: Channel;
  /** id ของบัญชีฝั่งเรา (page id / LINE destination) ใช้หา Connection */
  accountExternalId: string;
  /** id ของลูกค้าในแพลตฟอร์มนั้น */
  contactExternalId: string;
  contactName?: string;
  text: string;
  externalMessageId?: string;
  timestamp: Date;
  /** สำหรับ LINE: ใช้ reply ได้ฟรีภายในเวลาจำกัด */
  replyToken?: string;
}

export interface SendResult {
  ok: boolean;
  externalId?: string;
  error?: string;
}

export interface ChannelSecrets {
  [k: string]: string | undefined;
}

export interface ChannelAdapter {
  channel: Channel;
  /** ตรวจลายเซ็นของ webhook — ป้องกันคนปลอมข้อความเข้ามา */
  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>, secrets: ChannelSecrets): boolean;
  /** แปลง payload ของแพลตฟอร์มเป็นข้อความรูปแบบกลาง */
  parse(body: unknown): InboundMessage[];
  /** ส่งข้อความออกไปหาลูกค้า */
  send(secrets: ChannelSecrets, to: string, text: string, opts?: { replyToken?: string }): Promise<SendResult>;
}

export async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs = 15000): Promise<{ ok: boolean; status: number; json: any; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* ไม่ใช่ JSON */
  }
  return { ok: res.ok, status: res.status, json, text };
}
