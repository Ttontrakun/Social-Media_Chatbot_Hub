import { Response } from "express";

type Client = { id: number; workspaceId: string; res: Response };

let seq = 0;
const clients = new Set<Client>();

export function addClient(workspaceId: string, res: Response): () => void {
  const client: Client = { id: ++seq, workspaceId, res };
  clients.add(client);
  res.write(`event: ready\ndata: {"ok":true}\n\n`);
  const keepAlive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ปิดไปแล้ว */
    }
  }, 25000);
  return () => {
    clearInterval(keepAlive);
    clients.delete(client);
  };
}

/** ส่งเหตุการณ์ไปยังทุกแท็บที่เปิดอยู่ของ workspace นั้น */
export function broadcast(workspaceId: string, event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) {
    if (c.workspaceId !== workspaceId) continue;
    try {
      c.res.write(payload);
    } catch {
      clients.delete(c);
    }
  }
}

export function clientCount(): number {
  return clients.size;
}
