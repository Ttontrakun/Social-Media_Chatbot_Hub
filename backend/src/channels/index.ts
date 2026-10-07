import { Channel } from "../generated/prisma/client";
import { ChannelAdapter } from "./types";
import { lineAdapter } from "./line";
import { facebookAdapter, instagramAdapter } from "./meta";
import { xAdapter } from "./x";

export const adapters: Record<Channel, ChannelAdapter> = {
  LINE: lineAdapter,
  FACEBOOK: facebookAdapter,
  INSTAGRAM: instagramAdapter,
  X: xAdapter,
};

/** ชื่อที่ใช้ใน URL ของ webhook: /webhooks/line, /webhooks/facebook, ... */
export const slugToChannel: Record<string, Channel> = {
  line: Channel.LINE,
  facebook: Channel.FACEBOOK,
  instagram: Channel.INSTAGRAM,
  x: Channel.X,
};

export const channelToSlug: Record<Channel, string> = {
  LINE: "line",
  FACEBOOK: "facebook",
  INSTAGRAM: "instagram",
  X: "x",
};

export * from "./types";
