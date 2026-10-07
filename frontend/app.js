"use strict";
/* หน้าเว็บทั้งหมดทำงานกับ API จริง ไม่มีข้อมูลจำลองค้างในเบราว์เซอร์ */

const CH = {
  LINE: { label: "LINE", bg: "#E0F5E9", fg: "#0A6B34", solid: "#07A34B", glyph: "L" },
  FACEBOOK: { label: "Facebook", bg: "#E3EEFD", fg: "#0F4FB8", solid: "#1877F2", glyph: "f" },
  INSTAGRAM: { label: "Instagram", bg: "#FBE6F0", fg: "#A3154F", solid: "#C13584", glyph: "I" },
  X: { label: "X", bg: "#E8EAED", fg: "#18212D", solid: "#18212D", glyph: "X" },
};
const CHART_COL = { LINE: "#1baf7a", FACEBOOK: "#2a78d6", INSTAGRAM: "#e87ba4", X: "#4a3aa7" };
const BOT_COL = "#2a78d6";
const STAFF_COL = "#eb6834";

const state = {
  user: null,
  view: "inbox",
  filter: "all",
  q: "",
  sel: null,
  chat: false,
  conversations: [],
  current: null,
  draft: null,
  connections: [],
  webhookUrls: {},
  metaOAuthReady: false,
  documents: [],
  engine: {},
  bot: null,
  apiKeys: [],
  warnings: [],
  events: [],
  analytics: null,
  dash: { range: 7, table: false },
  busy: false,
};

/* ---------- helpers ---------- */
const $ = (s, r = document) => r.querySelector(s);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in props) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}
function toast(t) {
  const e = $("#toast");
  e.textContent = t;
  e.classList.add("on");
  clearTimeout(toast.h);
  toast.h = setTimeout(() => e.classList.remove("on"), 2600);
}
function timeOf(iso) {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "เมื่อวาน";
  return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" });
}
function tag(txt, bg, fg) {
  return el("span", { class: "tag", style: `background:${bg};color:${fg}` }, txt);
}
function avatar(name, color, size) {
  return el(
    "div",
    { class: "avatar", style: `width:${size}px;height:${size}px;background:${color || "#D9E2EC"};color:#18212D;font-size:${Math.round(size / 2.6)}px` },
    (name || "?").replace("@", "").charAt(0).toUpperCase()
  );
}
function avatarB(c, size) {
  const s = CH[c.channel] || CH.LINE;
  return el(
    "div",
    { class: "avwrap", style: `width:${size}px;height:${size}px` },
    avatar(c.name || (c.contact && c.contact.name), c.color || (c.contact && c.contact.color), size),
    el("span", { class: "abadge", "aria-hidden": "true", style: `background:${s.solid}` }, s.glyph)
  );
}
/** ครอบการเรียก API ให้แสดงข้อความผิดพลาดแทนที่จะเงียบ */
async function guard(fn, { silent = false } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      state.user = null;
      showAuth();
      return null;
    }
    if (!silent) toast(err.message || "เกิดข้อผิดพลาด");
    return null;
  }
}

/* ---------- data loading ---------- */
async function loadInbox() {
  const r = await guard(() => API.conversations());
  if (!r) return;
  state.conversations = r.conversations;
  if (state.sel && !state.conversations.some((c) => c.id === state.sel)) {
    state.sel = null;
    state.current = null;
  }
  render();
}
async function openConversation(id) {
  state.sel = id;
  state.chat = true;
  state.draft = null;
  render();
  const c = await guard(() => API.conversation(id));
  if (!c) return;
  state.current = c;
  const row = state.conversations.find((x) => x.id === id);
  if (row) row.unread = 0;
  render();
}
async function loadChannels() {
  const r = await guard(() => API.channels());
  if (!r) return;
  state.connections = r.connections;
  state.webhookUrls = r.webhookUrls;
  state.metaOAuthReady = r.metaOAuthReady;
  render();
}
async function loadDocuments() {
  const r = await guard(() => API.documents());
  if (!r) return;
  state.documents = r.documents;
  state.engine = r.engine;
  render();
}
async function loadSettings() {
  const r = await guard(() => API.settings());
  if (!r) return;
  state.bot = r.bot;
  state.apiKeys = r.apiKeys;
  state.warnings = r.warnings;
  state.engine = { ...state.engine, ...r.engine };
  render();
}
async function loadEvents() {
  const r = await guard(() => API.events(), { silent: true });
  if (!r) return;
  state.events = r.events;
  render();
}
async function loadAnalytics() {
  const r = await guard(() => API.analytics(state.dash.range));
  if (!r) return;
  state.analytics = r;
  render();
}

/* ---------- realtime ---------- */
let es = null;
function startStream() {
  if (es) es.close();
  es = API.stream({
    conversation: (e) => {
      const data = JSON.parse(e.data);
      if (state.current && state.current.id === data.id) state.current = data;
      loadInbox();
    },
    connection: () => loadChannels(),
    document: (e) => {
      const d = JSON.parse(e.data);
      const i = state.documents.findIndex((x) => x.id === d.id);
      if (i >= 0) {
        state.documents[i] = { ...state.documents[i], ...d };
        if (state.view === "kb") render();
      } else if (state.view === "kb") {
        // เหตุการณ์มาถึงก่อนที่รายการจะโหลดเสร็จ — ดึงรายการใหม่ทั้งชุด
        loadDocuments();
      }
      if (d.status === "READY") toast(`${d.filename} พร้อมใช้งานแล้ว (${d.chunkCount} ช่วงข้อความ)`);
      if (d.status === "FAILED") toast(`${d.filename}: ${d.error || "ประมวลผลไม่สำเร็จ"}`);
    },
    refresh: () => loadInbox(),
  });
  es.onerror = () => {
    /* เบราว์เซอร์จะเชื่อมต่อใหม่ให้เอง */
  };
}

/* ---------- inbox ---------- */
function needsStaff(c) {
  return c.awaitingStaff && c.status !== "CLOSED";
}
function visible() {
  return state.conversations.filter(
    (c) =>
      (state.filter === "all" || c.channel === state.filter) &&
      (!state.q ||
        (c.name + " " + (c.preview ? c.preview.body : "")).toLowerCase().includes(state.q.toLowerCase()))
  );
}
function previewText(c) {
  if (!c.preview) return "ยังไม่มีข้อความ";
  const p = { BOT: "Bot: ", AGENT: "คุณ: ", SYSTEM: "" }[c.preview.sender] || "";
  return p + c.preview.body;
}
function renderChips() {
  const box = $("#chips");
  box.replaceChildren();
  [["all", "ทั้งหมด"], ["LINE", "LINE"], ["FACEBOOK", "Facebook"], ["INSTAGRAM", "Instagram"], ["X", "X"]].forEach(
    ([k, l]) => {
      box.append(
        el("button", { class: "chip" + (state.filter === k ? " on" : ""), onclick: () => { state.filter = k; render(); } }, l)
      );
    }
  );
}
function renderList() {
  const list = visible();
  const waiting = state.conversations.filter(needsStaff).length;
  const cnt = $("#count");
  cnt.textContent = waiting ? `รอพนักงาน ${waiting}` : `${list.length} บทสนทนา`;
  cnt.className = "pill " + (waiting ? "urgent" : "calm");

  const box = $("#items");
  box.replaceChildren();
  if (!state.conversations.length) {
    box.append(
      el("div", { class: "empty" },
        state.connections.length
          ? "ยังไม่มีข้อความเข้ามา กดปุ่มจำลองข้อความเพื่อทดลองบอท"
          : "ยังไม่ได้เชื่อมช่องทางใด — ไปที่เมนู \"ช่องทาง\" เพื่อเริ่มต้น")
    );
    return;
  }
  if (!list.length) {
    box.append(el("div", { class: "empty" }, "ไม่พบบทสนทนา ลองเปลี่ยนตัวกรองหรือคำค้นหา"));
    return;
  }
  list.forEach((c) => {
    const s = CH[c.channel];
    const need = needsStaff(c);
    const st =
      c.status === "CLOSED"
        ? tag("ปิดเคสแล้ว", "#EEF1F5", "#5A6676")
        : need
        ? tag("รอพนักงาน", "#FDECEA", "#9B1C16")
        : c.mode === "BOT"
        ? tag("บอทดูแล", "#E3F3F0", "#0B5C56")
        : tag("พนักงานตอบแล้ว", "#EEF1F5", "#18212D");
    box.append(
      el("button",
        {
          class: "item" + (c.id === state.sel ? " sel" : "") + (c.unread ? " unread" : ""),
          "aria-current": c.id === state.sel ? "true" : "false",
          onclick: () => openConversation(c.id),
        },
        avatarB(c, 46),
        el("div", { class: "body" },
          el("div", { class: "row" }, el("span", { class: "nm" }, c.name), el("span", { class: "when" }, timeOf(c.lastMessageAt))),
          el("div", { class: "snip" }, previewText(c)),
          el("div", { class: "tags" },
            tag(s.label, s.bg, s.fg),
            st,
            c.connectionStatus === "EXPIRED" ? tag("ต้องเชื่อมใหม่", "#FFF4DB", "#7A4300") : null,
            c.unread
              ? el("span", { class: "badge" + (need ? " urgent" : ""), "aria-label": `ข้อความใหม่ ${c.unread}` + (need ? " รอพนักงาน" : "") }, String(c.unread))
              : null)))
    );
  });
}

function renderConv() {
  const box = $("#conv");
  box.replaceChildren();
  const c = state.current;
  if (!c) {
    box.append(el("div", { class: "empty" }, state.sel ? "กำลังโหลด…" : "เลือกบทสนทนาจากรายการด้านซ้าย"));
    return;
  }
  const s = CH[c.channel];
  const usable = c.connectionStatus === "CONNECTED" && c.status !== "CLOSED";

  box.append(
    el("header", { class: "conv-head" },
      el("button", { class: "btn backbtn", "aria-label": "กลับไปรายการแชท", onclick: () => { state.chat = false; render(); } }, "‹ กลับ"),
      avatarB({ channel: c.channel, name: c.contact.name, color: c.contact.color }, 44),
      el("div", { class: "who" },
        el("div", { style: "font-weight:700;font-size:16px" }, c.contact.name),
        el("div", { style: "font-size:12px;color:var(--muted)" }, `ผ่าน ${s.label}${c.accountName ? " · " + c.accountName : ""}`)),
      el("span", { style: "font-size:13px;color:var(--muted)" }, "โหมด"),
      el("div", { class: "seg", role: "group", "aria-label": "สลับโหมดบอทและพนักงาน" },
        el("button", {
          class: c.mode === "BOT" ? "on" : "",
          onclick: () => c.mode !== "BOT" && guard(async () => { state.current = await API.patchConversation(c.id, { mode: "BOT" }); loadInbox(); }),
        }, "Bot"),
        el("button", {
          class: c.mode === "HUMAN" ? "on" : "",
          onclick: () => c.mode !== "HUMAN" && guard(async () => { state.current = await API.patchConversation(c.id, { mode: "HUMAN" }); loadInbox(); }),
        }, "พนักงาน")),
      el("button", {
        class: "btn",
        onclick: () => guard(async () => {
          state.current = await API.patchConversation(c.id, { status: c.status === "CLOSED" ? "OPEN" : "CLOSED" });
          toast(state.current.status === "CLOSED" ? "ปิดเคสแล้ว" : "เปิดเคสอีกครั้ง");
          loadInbox();
        }),
      }, c.status === "CLOSED" ? "เปิดเคสใหม่" : "ปิดเคส"))
  );

  const ms = el("div", { class: "msgs", id: "msgs" });
  if (c.connectionStatus !== "CONNECTED") {
    ms.append(el("div", { class: "sys", style: "align-self:stretch;text-align:center" },
      `ช่องทาง ${s.label} ${c.connectionStatus === "EXPIRED" ? "ต้องเชื่อมต่อใหม่" : "ยังไม่ได้เชื่อมต่อ"} — ส่งข้อความตอบกลับไม่ได้`));
  }
  c.messages.forEach((m) => {
    if (m.sender === "SYSTEM") {
      ms.append(el("div", { class: "sys" }, m.body));
      return;
    }
    const cls = m.sender === "CUSTOMER" ? "cust" : m.sender === "BOT" ? "bot" : "staff";
    const t = timeOf(m.at);
    const meta =
      m.sender === "BOT" ? `Bot · ${t}${m.sources.length ? " · อ้างอิง: " + m.sources.join(", ") : ""}` :
      m.sender === "AGENT" ? `คุณ · ${t}` : t;
    ms.append(el("div", { class: "m " + cls }, el("div", { class: "b" }, m.body), el("small", {}, meta)));
  });

  // กล่องร่างคำตอบของ AI — ดึงจาก backend เมื่อผู้ใช้กด
  if (usable && c.mode === "HUMAN") {
    const d = state.draft && state.draft.id === c.id ? state.draft : null;
    if (!d) {
      ms.append(el("div", { class: "draft" },
        el("div", { class: "t" }, "AI ร่างคำตอบจากฐานความรู้"),
        el("div", { style: "color:var(--muted)" }, "ให้ AI ค้นเอกสารแล้วร่างคำตอบของข้อความล่าสุด"),
        el("div", {}, el("button", { class: "btn pri", onclick: () => requestDraft(c.id) }, "ขอร่างคำตอบ"))));
    } else if (d.loading) {
      ms.append(el("div", { class: "draft" }, el("div", { class: "t" }, "AI ร่างคำตอบจากฐานความรู้"), el("div", { role: "status" }, "กำลังค้นเอกสาร…")));
    } else {
      ms.append(el("div", { class: "draft" },
        el("div", { class: "t" }, "AI ร่างคำตอบจากฐานความรู้ (ยังไม่ได้ส่ง)"),
        el("div", {}, d.text),
        d.sources && d.sources.length ? el("small", { style: "color:var(--muted)" }, "อ้างอิง: " + d.sources.join(", ")) : null,
        !d.confident ? el("small", { style: "color:var(--warn-fg)" }, "ไม่พบข้อมูลที่ตรงพอในฐานความรู้ — นี่คือข้อความสำรอง") : null,
        el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
          el("button", { class: "btn pri", onclick: () => sendMessage(c.id, d.text) }, "ส่งตามร่างนี้"),
          el("button", {
            class: "btn",
            onclick: () => { const t = $("#ta"); t.value = d.text; t.focus(); t.setSelectionRange(t.value.length, t.value.length); },
          }, "แก้ไขก่อนส่ง"))));
    }
  }
  box.append(ms);

  const ta = el("textarea", { id: "ta", rows: "2", placeholder: `พิมพ์ข้อความตอบกลับผ่าน ${s.label}…`, "aria-label": "พิมพ์ข้อความตอบกลับ", disabled: !usable });
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(c.id, ta.value);
    }
  });
  box.append(
    el("div", { class: "composer" },
      el("button", { class: "btn", "aria-label": "แนบไฟล์", onclick: () => toast("ยังไม่รองรับการแนบไฟล์ในเวอร์ชันนี้") }, "แนบ"),
      ta,
      el("button", { class: "btn dark", disabled: !usable, onclick: () => sendMessage(c.id, ta.value) }, "ส่ง"))
  );
  ms.scrollTop = ms.scrollHeight;
}

async function requestDraft(id) {
  state.draft = { id, loading: true };
  render();
  const r = await guard(() => API.draft(id));
  state.draft = r ? { id, ...r } : null;
  render();
}
async function sendMessage(id, text) {
  if (!text || !text.trim() || state.busy) return;
  state.busy = true;
  const r = await guard(() => API.sendMessage(id, text.trim()));
  state.busy = false;
  if (!r) return;
  state.current = r;
  state.draft = null;
  loadInbox();
  render();
}

function renderSide() {
  const box = $("#side");
  box.replaceChildren();
  const c = state.current;
  if (!c) return;
  const contact = c.contact;
  box.append(
    el("div", { style: "display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center" },
      avatar(contact.name, contact.color, 72),
      el("div", { style: "font-weight:700;font-size:18px" }, contact.name),
      el("div", { style: "font-size:13px;color:var(--muted)" }, "ลูกค้าตั้งแต่ " + new Date(contact.since).toLocaleDateString("th-TH", { day: "numeric", month: "short", year: "numeric" }))),

    el("div", {}, el("h2", {}, "ช่องทางที่รวมเป็นโปรไฟล์เดียว"),
      ...contact.channels.map((k) =>
        el("div", { style: "display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:10px;background:var(--soft);margin-bottom:8px" },
          tag(CH[k].label, CH[k].bg, CH[k].fg), el("span", { style: "font-size:13px" }, "เชื่อมแล้ว")))),

    el("div", {}, el("h2", {}, "แท็ก"),
      el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" },
        ...contact.tags.map((t) =>
          el("span", { style: "display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 12px;border-radius:14px;background:var(--bg);font-size:12px" }, t,
            el("button", {
              "aria-label": "ลบแท็ก " + t,
              style: "width:28px;height:28px;border:0;border-radius:50%;background:transparent;font-size:16px",
              onclick: () => guard(async () => { state.current = await API.setTags(c.id, contact.tags.filter((x) => x !== t)); render(); }),
            }, "×"))),
        el("button", {
          style: "height:28px;padding:0 12px;border:1px dashed var(--line2);border-radius:14px;background:#fff;color:var(--muted);font-size:12px",
          onclick: () => {
            const t = prompt("ชื่อแท็ก");
            if (t && t.trim()) guard(async () => { state.current = await API.setTags(c.id, [...contact.tags, t.trim()]); render(); });
          },
        }, "+ เพิ่มแท็ก"))),

    el("div", {}, el("h2", {}, "ผู้รับผิดชอบ"),
      el("button", {
        class: "btn", style: "width:100%;height:44px;text-align:left",
        onclick: () => guard(async () => {
          state.current = await API.patchConversation(c.id, { assignee: c.assignee ? null : state.user.name });
          loadInbox();
        }),
      }, c.assignee || "ยังไม่มอบหมาย (กดเพื่อรับเคส)"))
  );
}

/* ---------- ช่องทาง ---------- */
function renderChannels() {
  const box = $("#chlist");
  box.replaceChildren();

  const byChannel = {};
  for (const c of state.connections) (byChannel[c.channel] = byChannel[c.channel] || []).push(c);

  Object.keys(CH).forEach((k) => {
    const s = CH[k];
    const list = byChannel[k] || [];
    if (!list.length) {
      box.append(el("div", { class: "card" },
        tag(s.label, s.bg, s.fg),
        el("div", { class: "grow" }, el("span", { class: "dot", style: "background:#9AA5B4" }), "ยังไม่ได้เชื่อมต่อ"),
        el("button", { class: "btn pri", onclick: () => openConnect(k) }, "เชื่อมต่อ")));
      return;
    }
    list.forEach((conn) => {
      const expired = conn.status === "EXPIRED";
      box.append(el("div", { class: "card" },
        tag(s.label, s.bg, s.fg),
        el("div", { class: "grow" },
          el("div", {}, el("span", { class: "dot", style: `background:${expired ? "#D98A00" : "#1A9E5C"}` }),
            expired ? "ต้องเชื่อมต่อใหม่ · " + conn.accountName : "เชื่อมต่อแล้ว · " + conn.accountName),
          el("small", { style: "color:var(--muted)" }, "ID: " + conn.externalId),
          conn.lastError ? el("div", { style: "color:var(--urgent-d);font-size:12px" }, conn.lastError) : null),
        el("label", { class: "switch" },
          el("input", {
            type: "checkbox", checked: conn.botEnabled && !expired, disabled: expired,
            onchange: (e) => guard(async () => {
              await API.patchChannel(conn.id, { botEnabled: e.target.checked });
              toast(`Bot ${s.label} ${e.target.checked ? "เปิด" : "ปิด"}`);
              loadChannels();
            }),
          }), "Bot"),
        expired ? el("button", { class: "btn pri", onclick: () => openConnect(k) }, "เชื่อมต่อใหม่") : null,
        el("button", {
          class: "btn danger",
          onclick: () => {
            if (!confirm(`ตัดการเชื่อมต่อ ${s.label} (${conn.accountName})?\nบทสนทนาของช่องทางนี้จะถูกลบด้วย`)) return;
            guard(async () => { await API.disconnectChannel(conn.id); toast("ตัดการเชื่อมต่อแล้ว"); loadChannels(); loadInbox(); });
          },
        }, "ตัดการเชื่อมต่อ")));
    });
    box.append(el("div", { style: "margin:-6px 0 6px" },
      el("button", { class: "ghost", style: "padding:0 14px", onclick: () => openConnect(k) }, `+ เพิ่มบัญชี ${s.label} อีก`)));
  });
}

/* ---------- modal ---------- */
let modalReturnFocus = null;
function openModal(title, body) {
  $("#mtitle").textContent = title;
  $("#mbody").replaceChildren(body);
  modalReturnFocus = document.activeElement;
  $("#modal").hidden = false;
  const f = $("#mbody").querySelector("input:not([readonly]),button");
  if (f) f.focus();
}
function closeModal() {
  $("#modal").hidden = true;
  if (modalReturnFocus && modalReturnFocus.focus) modalReturnFocus.focus();
}
function field(label, id, type, ph) {
  return el("label", { class: "f" }, label, el("input", { class: "field", id, type: type || "text", placeholder: ph || "", autocomplete: "off", style: "flex:none;width:100%" }));
}
function btnrow(...b) {
  return el("div", { style: "display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap" }, ...b);
}
function copyText(t) {
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast("คัดลอกแล้ว"), () => toast("คัดลอกไม่สำเร็จ"));
  else toast("เบราว์เซอร์นี้คัดลอกอัตโนมัติไม่ได้");
}
function webhookRow(channel) {
  const url = state.webhookUrls[channel] || "";
  return el("div", { style: "display:flex;flex-direction:column;gap:4px;font-weight:500" }, "Webhook URL (นำไปวางในแพลตฟอร์ม)",
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      el("input", { class: "field", readonly: true, value: url, "aria-label": "Webhook URL", style: "flex:1 1 220px" }),
      el("button", { class: "btn", type: "button", onclick: () => copyText(url) }, "คัดลอก")));
}

function openConnect(channel) {
  if (channel === "LINE") return openLine();
  return openManual(channel);
}

function openLine() {
  const err = el("div", { class: "aerr", role: "alert" });
  const submit = el("button", { class: "btn pri", type: "submit" }, "เชื่อมต่อ");
  const form = el("form", { novalidate: true, style: "display:flex;flex-direction:column;gap:14px" },
    el("ol", { style: "margin:0;padding-left:20px;color:var(--muted);font-size:13px" },
      el("li", {}, "สร้าง Messaging API channel ใน LINE Developers Console"),
      el("li", {}, "คัดลอก Channel ID, Channel secret และ Channel access token มากรอกด้านล่าง"),
      el("li", {}, "นำ Webhook URL ไปวางในหน้า Messaging API แล้วกด Verify")),
    field("ชื่อบัญชี (ตั้งเอง)", "l_name", "text", "เช่น ร้านตัวอย่าง"),
    field("Channel ID", "l_id"),
    field("Channel secret", "l_secret", "password"),
    field("Channel access token", "l_token", "password"),
    webhookRow("LINE"),
    el("small", { style: "color:var(--muted)" }, "ระบบจะเรียก LINE เพื่อตรวจสอบ token แล้วเก็บแบบเข้ารหัสไว้ที่เซิร์ฟเวอร์"),
    err,
    btnrow(el("button", { class: "btn", type: "button", onclick: closeModal }, "ยกเลิก"), submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const v = (id) => form.querySelector("#" + id).value.trim();
    if (!v("l_id") || !v("l_secret") || !v("l_token")) {
      err.textContent = "กรอก Channel ID, Channel secret และ access token ให้ครบ";
      return;
    }
    submit.disabled = true;
    submit.textContent = "กำลังตรวจสอบ…";
    try {
      await API.connectLine({ accountName: v("l_name"), channelId: v("l_id"), channelSecret: v("l_secret"), accessToken: v("l_token") });
      closeModal();
      toast("เชื่อมต่อ LINE แล้ว");
      loadChannels();
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      submit.textContent = "เชื่อมต่อ";
    }
  });
  openModal("เชื่อมต่อ LINE Official Account", form);
}

function openManual(channel) {
  const name = CH[channel].label;
  const isX = channel === "X";
  const err = el("div", { class: "aerr", role: "alert" });
  const submit = el("button", { class: "btn pri", type: "submit" }, "เชื่อมต่อ");
  const steps = {
    FACEBOOK: ["สร้าง Meta App แล้วขอสิทธิ์ pages_messaging", "คัดลอก Page ID และ Page access token ของเพจ", "กรอก App secret เพื่อให้ระบบตรวจลายเซ็น webhook ได้"],
    INSTAGRAM: ["บัญชี Instagram ต้องเป็น Business หรือ Creator และผูกกับเพจ Facebook", "ใช้ Instagram account ID และ Page access token ของเพจที่ผูกไว้", "กรอก App secret ของ Meta App เดียวกัน"],
    X: ["ต้องใช้แพ็กเกจ X API ที่เข้าถึง DM ได้", "กรอก user ID ของบัญชีและ access token", "Consumer secret ใช้ตรวจลายเซ็น webhook (Account Activity API)"],
  }[channel];

  const form = el("form", { novalidate: true, style: "display:flex;flex-direction:column;gap:14px" },
    el("ol", { style: "margin:0;padding-left:20px;color:var(--muted);font-size:13px" }, ...steps.map((s) => el("li", {}, s))),
    field(isX ? "User ID ของบัญชี" : channel === "INSTAGRAM" ? "Instagram account ID" : "Page ID", "m_id"),
    field("ชื่อบัญชี (แสดงในระบบ)", "m_name", "text", channel === "FACEBOOK" ? "เช่น เพจร้านตัวอย่าง" : ""),
    field(isX ? "Access token" : "Page access token", "m_token", "password"),
    field(isX ? "Consumer secret" : "App secret ของ Meta", "m_secret", "password"),
    webhookRow(channel),
    channel === "X"
      ? el("small", { style: "color:var(--warn-fg)" }, "X API มีค่าใช้จ่ายสูงและการรับ DM แบบ realtime ต้องใช้แพ็กเกจระดับสูง ควรตรวจสอบก่อนใช้งานจริง")
      : null,
    state.metaOAuthReady && channel !== "X"
      ? el("button", { class: "btn", type: "button", onclick: () => guard(async () => { const r = await API.metaOAuthStart(); window.open(r.url, "_blank", "noopener"); }) }, "หรือเชื่อมผ่าน OAuth ของ Meta")
      : null,
    err,
    btnrow(el("button", { class: "btn", type: "button", onclick: closeModal }, "ยกเลิก"), submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const v = (id) => form.querySelector("#" + id).value.trim();
    if (!v("m_id") || !v("m_name") || !v("m_token")) {
      err.textContent = "กรอก ID ชื่อบัญชี และ access token ให้ครบ";
      return;
    }
    submit.disabled = true;
    submit.textContent = "กำลังบันทึก…";
    try {
      await API.connectManual({ channel, externalId: v("m_id"), accountName: v("m_name"), accessToken: v("m_token"), appSecret: v("m_secret") });
      closeModal();
      toast(`เชื่อมต่อ ${name} แล้ว`);
      loadChannels();
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      submit.textContent = "เชื่อมต่อ";
    }
  });
  openModal(`เชื่อมต่อ ${name}`, form);
}

/* ---------- ฐานความรู้ ---------- */
function renderKB() {
  const e = state.engine || {};
  $("#kbengine").replaceChildren(
    el("div", { class: "card" },
      el("div", { class: "grow" },
        el("div", {}, el("span", { class: "dot", style: `background:${e.qdrant ? "#1A9E5C" : "#C8312B"}` }),
          e.qdrant ? "Qdrant เชื่อมต่อแล้ว" : "ติดต่อ Qdrant ไม่ได้"),
        el("small", { style: "color:var(--muted)" },
          `embedding: ${e.embeddingProvider === "demo" ? "โหมดทดลอง (คุณภาพต่ำ)" : e.embeddingModel}` +
          ` · LLM: ${e.llmProvider === "extractive" ? "ยังไม่ได้ต่อ LLM" : e.llmModel}` +
          ` · OCR: ${e.ocr ? "พร้อมอ่าน PDF สแกนและรูปภาพ" : "ยังไม่ได้ต่อ (PDF สแกนจะอ่านไม่ได้)"}` +
          (e.rerank ? " · reranker: เปิดใช้" : ""))))
  );

  const box = $("#kblist");
  box.replaceChildren();
  if (!state.documents.length) {
    box.append(el("div", { class: "empty" }, "ยังไม่มีเอกสาร อัปโหลด PDF, Word, Excel หรือไฟล์ข้อความเพื่อให้บอทใช้ตอบ"));
    return;
  }
  state.documents.forEach((d) => {
    const st =
      d.status === "READY" ? tag(`พร้อมใช้ · ${d.chunkCount} ช่วง`, "#DDF0EC", "#0B5C56") :
      d.status === "FAILED" ? tag("ไม่สำเร็จ", "#FDECEA", "#9B1C16") :
      tag(d.status === "PROCESSING" ? "กำลังประมวลผล…" : "รอคิว", "#FFF4DB", "#7A4300");
    box.append(el("div", { class: "card" },
      el("div", { class: "grow" },
        el("b", {}, d.filename),
        el("div", { style: "color:var(--muted);font-size:12px" }, Math.max(1, Math.round(d.bytes / 1024)) + " KB"),
        d.error ? el("div", { style: "color:var(--urgent-d);font-size:12px" }, d.error) : null),
      st,
      el("button", {
        class: "btn danger",
        onclick: () => {
          if (!confirm(`ลบ ${d.filename} ออกจากฐานความรู้?`)) return;
          guard(async () => { await API.deleteDocument(d.id); toast("ลบแล้ว"); loadDocuments(); });
        },
      }, "ลบ")));
  });
}

function renderKbTest() {
  const box = $("#kbtest");
  if (box.dataset.ready) return;
  box.dataset.ready = "1";
  const input = el("input", { class: "field", placeholder: "เช่น ค่าส่งเท่าไหร่ ส่งกี่วัน", "aria-label": "คำถามทดสอบ" });
  const out = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
  const run = async () => {
    const q = input.value.trim();
    if (!q) return;
    out.replaceChildren(el("div", { role: "status", style: "color:var(--muted)" }, "กำลังค้น…"));
    const r = await guard(() => API.testKb(q));
    if (!r) { out.replaceChildren(); return; }
    out.replaceChildren(
      el("div", { class: "card", style: "flex-direction:column;align-items:stretch;gap:6px" },
        el("b", {}, r.confident ? "บอทจะตอบว่า" : "บอทจะส่งต่อพนักงาน และตอบข้อความสำรองว่า"),
        el("div", {}, r.answer),
        r.sources.length ? el("small", { style: "color:var(--muted)" }, "อ้างอิง: " + r.sources.join(", ")) : null),
      (r.variants || []).length > 1
        ? el("div", { style: "font-size:12px;color:var(--muted)" }, "คำค้นที่ระบบขยายให้: " + r.variants.join(" · "))
        : null,
      el("div", { style: "font-size:13px;color:var(--muted)" }, `ช่วงข้อความที่ใกล้เคียงที่สุด (เกณฑ์ผ่าน ${r.minScore})`),
      ...r.hits.map((h) =>
        el("div", { class: "card", style: "flex-direction:column;align-items:stretch;gap:4px" },
          el("div", { style: "display:flex;justify-content:space-between;gap:8px;align-items:center" },
            el("b", {}, h.filename + (h.label ? " · " + h.label : " #" + h.chunkIndex)),
            el("span", { style: "display:flex;gap:8px;align-items:center" },
              h.expanded ? tag("รวมบล็อกเดิมแล้ว", "#E3F3F0", "#0B5C56") : null,
              h.rerankScore !== null && h.rerankScore !== undefined
                ? el("span", { style: "font-size:12px;color:var(--muted)" }, "rerank " + Number(h.rerankScore).toFixed(2))
                : null,
              el("span", { style: `font-weight:700;color:${h.score >= r.minScore ? "#0B5C56" : "#9B1C16"}` }, h.score.toFixed(3)))),
          el("div", { style: "font-size:13px;color:var(--muted);white-space:pre-wrap" }, h.text))));
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); run(); } });
  box.replaceChildren(
    el("h2", { style: "margin:0;font-size:16px" }, "ลองถามบอท"),
    el("p", { style: "margin:0;color:var(--muted);font-size:13px" }, "ดูว่าบอทจะตอบอะไรและใช้ช่วงข้อความไหนจากเอกสาร ก่อนเปิดให้ตอบลูกค้าจริง"),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, input, el("button", { class: "btn pri", onclick: run }, "ทดสอบ")),
    out
  );
}

/* ---------- ตั้งค่าบอท ---------- */
function renderSettings() {
  const box = $("#setbox");
  box.replaceChildren();
  if (!state.bot) {
    box.append(el("div", { class: "empty" }, "กำลังโหลด…"));
    return;
  }
  const cfg = { ...state.bot };
  const save = async (patch, msg) => {
    const r = await guard(() => API.saveBot(patch));
    if (!r) return;
    state.bot = r.bot;
    if (msg) toast(msg);
    render();
  };
  const sec = (title, desc, ...kids) =>
    el("div", { style: "display:flex;flex-direction:column;gap:10px" },
      el("h2", { style: "margin:0;font-size:16px" }, title),
      el("p", { style: "margin:0;color:var(--muted);font-size:13px" }, desc), ...kids);
  const area = (label, rows, val, onInput) => {
    const t = el("textarea", { class: "field", rows: String(rows), "aria-label": label, style: "height:auto;padding:10px 14px;width:100%;resize:vertical" });
    t.value = val;
    t.addEventListener("input", () => onInput(t.value));
    return t;
  };
  const radio = (v, title, desc) =>
    el("label", { class: "card", style: "cursor:pointer;align-items:flex-start;flex-wrap:nowrap" },
      el("input", { type: "radio", name: "mode", value: v, checked: cfg.mode === v, style: "width:20px;height:20px;accent-color:var(--accent);margin-top:2px", onchange: () => save({ mode: v }, "เปลี่ยนโหมดการตอบแล้ว") }),
      el("div", { class: "grow" }, el("b", {}, title), el("div", { style: "color:var(--muted);font-size:13px" }, desc)));

  const tin = el("input", { class: "field", placeholder: "เพิ่มหัวข้อ เช่น ขอใบกำกับภาษี", "aria-label": "เพิ่มหัวข้อที่ส่งต่อพนักงาน" });
  const add = () => {
    const v = tin.value.trim();
    if (v && !cfg.handoverTopics.includes(v)) save({ handoverTopics: [...cfg.handoverTopics, v] }, "เพิ่มหัวข้อแล้ว");
  };
  tin.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); add(); } });

  const warn = state.warnings && state.warnings.length
    ? el("div", { class: "card", style: "flex-direction:column;align-items:stretch;gap:6px;background:var(--warn-bg);border-color:#E8D5A8" },
        el("b", {}, "ข้อควรแก้ก่อนใช้งานจริง"),
        ...state.warnings.map((w) => el("div", { style: "font-size:13px;color:var(--warn-fg)" }, "• " + w)))
    : null;

  box.append(
    warn,
    sec("บทบาทและน้ำเสียง", "ใช้เป็นคำสั่งระบบที่ส่งให้ LLM ทุกครั้งที่บอทตอบ",
      area("บทบาทและน้ำเสียงของบอท", 4, cfg.persona, (v) => { cfg.persona = v; })),
    sec("โหมดการตอบ", "ช่วงแรกแนะนำโหมดร่างคำตอบ แล้วค่อยเปิดอัตโนมัติเมื่อคุณภาพนิ่ง",
      radio("AUTO", "ตอบอัตโนมัติ", "บอทตอบลูกค้าทันทีจากฐานความรู้"),
      radio("DRAFT", "ร่างให้แอดมินกดส่ง", "AI เตรียมร่างคำตอบ แอดมินตรวจแล้วกดส่งเอง")),
    sec("หัวข้อที่ส่งต่อพนักงานเสมอ", "ถ้าข้อความลูกค้ามีคำเหล่านี้ บอทจะไม่ตอบเอง และสลับเป็นโหมดพนักงาน",
      el("div", { style: "display:flex;flex-wrap:wrap;gap:8px" },
        ...cfg.handoverTopics.map((t) =>
          el("span", { style: "display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 14px;border-radius:18px;background:#fff;border:1px solid var(--line2)" }, t,
            el("button", { "aria-label": "ลบหัวข้อ " + t, style: "width:32px;height:32px;border:0;border-radius:50%;background:transparent;font-size:18px", onclick: () => save({ handoverTopics: cfg.handoverTopics.filter((x) => x !== t) }) }, "×")))),
      el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" }, tin, el("button", { class: "btn", onclick: add }, "เพิ่มหัวข้อ"))),
    sec("ข้อความเมื่อบอทไม่พบคำตอบ", "บอทจะส่งข้อความนี้แล้วส่งต่อให้พนักงาน แทนการเดาคำตอบ",
      area("ข้อความเมื่อบอทไม่พบคำตอบ", 2, cfg.fallback, (v) => { cfg.fallback = v; })),
    sec("ความเข้มงวดของการค้นหา", `คะแนนความใกล้เคียงขั้นต่ำที่ยอมให้บอทตอบ (ตอนนี้ ${cfg.minScore}) ยิ่งสูงยิ่งเดาน้อยแต่ส่งต่อพนักงานบ่อยขึ้น`,
      el("div", { style: "display:flex;gap:16px;flex-wrap:wrap;align-items:center" },
        el("label", { class: "f" }, "คะแนนขั้นต่ำ",
          el("input", { class: "field", type: "number", min: "0", max: "1", step: "0.05", value: String(cfg.minScore), id: "minScore", style: "flex:none;width:120px" })),
        el("label", { class: "f" }, "จำนวนช่วงข้อความที่ส่งให้ LLM",
          el("input", { class: "field", type: "number", min: "1", max: "20", step: "1", value: String(cfg.topK), id: "topK", style: "flex:none;width:120px" })))),
    el("div", { style: "display:flex;gap:8px;flex-wrap:wrap" },
      el("button", {
        class: "btn pri",
        onclick: () => save({
          persona: cfg.persona,
          fallback: cfg.fallback,
          minScore: Number($("#minScore").value),
          topK: Number($("#topK").value),
        }, "บันทึกการตั้งค่าแล้ว"),
      }, "บันทึก"))
  );
}

/* ---------- API / integrations ---------- */
function renderApi() {
  const box = $("#apibox");
  box.replaceChildren();
  const key = state.apiKeys[0];

  box.append(
    el("div", { class: "card" },
      el("div", { class: "grow" },
        el("b", {}, "Webhook ขาออก"),
        el("div", { style: "color:var(--muted);font-size:13px" }, "ระบบจะยิง event ไปที่ URL นี้ทุกครั้งที่ส่งข้อความหาลูกค้า พร้อมลายเซ็น x-hub-signature-256")),
      key
        ? el("input", { class: "field", id: "wh", value: key.webhookUrl || "", placeholder: "https://example.com/hooks/hub", "aria-label": "Webhook URL" })
        : el("div", { style: "color:var(--muted)" }, "สร้าง API key ก่อนจึงจะตั้ง webhook ได้"),
      key ? el("label", { class: "switch" }, el("input", { type: "checkbox", id: "whon", checked: key.webhookOn }), "เปิดส่ง") : null,
      key ? el("button", {
        class: "btn",
        onclick: () => guard(async () => {
          const url = $("#wh").value.trim();
          await API.patchApiKey(key.id, { webhookUrl: url || null, webhookOn: $("#whon").checked });
          toast("บันทึก webhook แล้ว");
          loadSettings();
        }),
      }, "บันทึก") : null)
  );

  const keysBox = el("div", { style: "display:flex;flex-direction:column;gap:12px" });
  if (!state.apiKeys.length) keysBox.append(el("div", { class: "empty" }, "ยังไม่มี API key"));
  state.apiKeys.forEach((k) => {
    keysBox.append(el("div", { class: "card" },
      el("div", { class: "grow" }, el("b", {}, k.name),
        el("div", { style: "color:var(--muted);font-family:ui-monospace,monospace;font-size:13px" }, k.prefix + "••••••••••••"),
        el("small", { style: "color:var(--muted)" }, k.lastUsedAt ? "ใช้ล่าสุด " + new Date(k.lastUsedAt).toLocaleString("th-TH") : "ยังไม่เคยถูกใช้")),
      el("button", {
        class: "btn danger",
        onclick: () => {
          if (!confirm(`ลบ API key "${k.name}"? ระบบที่ใช้ key นี้อยู่จะเรียกไม่ได้ทันที`)) return;
          guard(async () => { await API.deleteApiKey(k.id); toast("ลบแล้ว"); loadSettings(); });
        },
      }, "ลบ")));
  });

  box.append(
    el("div", { style: "display:flex;flex-direction:column;gap:10px" },
      el("div", { style: "display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap" },
        el("h2", { style: "margin:0;font-size:16px" }, "API key"),
        el("button", {
          class: "btn pri",
          onclick: () => guard(async () => {
            const name = prompt("ชื่อ API key", "ระบบร้าน");
            if (!name) return;
            const r = await API.createApiKey(name);
            showKeyOnce(r.key);
            loadSettings();
          }),
        }, "สร้าง API key ใหม่")),
      keysBox)
  );
}

function showKeyOnce(key) {
  openModal("API key ใหม่",
    el("div", { style: "display:flex;flex-direction:column;gap:14px" },
      el("p", { style: "margin:0;color:var(--warn-fg)" }, "คัดลอกเก็บไว้ตอนนี้ — ระบบเก็บเฉพาะค่า hash จะไม่แสดง key นี้อีก"),
      el("code", { style: "display:block;padding:12px 14px;border-radius:10px;background:var(--soft);word-break:break-all;font-size:13px" }, key),
      btnrow(el("button", { class: "btn", onclick: () => copyText(key) }, "คัดลอก"),
        el("button", { class: "btn pri", onclick: closeModal }, "เก็บเรียบร้อยแล้ว"))));
}

function renderLog() {
  const b = $("#log");
  const rows = state.events.length
    ? state.events.map((e) => `[${new Date(e.at).toLocaleTimeString("th-TH", { hour12: false })}] ${e.kind} ${e.message}`)
    : ["(ยังไม่มีเหตุการณ์)"];
  b.replaceChildren(...rows.map((t) => el("div", {}, t)));
}

/* ---------- แดชบอร์ด ---------- */
function renderDash() {
  const a = state.analytics;
  const d = state.dash;
  document.querySelectorAll("[data-range]").forEach((b) => {
    const on = Number(b.dataset.range) === d.range;
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
  });
  $("#dtable").textContent = d.table ? "ดูเป็นกราฟ" : "ดูเป็นตาราง";
  if (!a) {
    $("#kpis").replaceChildren(el("div", { class: "empty" }, "กำลังโหลด…"));
    $("#charts").replaceChildren();
    return;
  }

  const kpi = (v, l, cls) => el("div", { class: "kpi" + (cls ? " " + cls : "") }, el("b", {}, String(v)), el("span", {}, l));
  const secs = a.kpi.avgFirstReplySeconds;
  const avgLabel = secs === null ? "–" : secs < 60 ? `${secs} วิ` : `${Math.floor(secs / 60)} นาที ${secs % 60} วิ`;
  $("#kpis").replaceChildren(
    kpi(a.kpi.waiting, "รอพนักงานตอบตอนนี้", a.kpi.waiting ? "urgent" : ""),
    kpi(a.kpi.open, "บทสนทนาที่ยังเปิดอยู่"),
    kpi(a.kpi.inbound.toLocaleString("en-US"), `ข้อความเข้า ${a.days} วัน`),
    kpi(a.kpi.botRate === null ? "–" : a.kpi.botRate + "%", "บอทตอบเองได้"),
    kpi(avgLabel, "เวลาตอบแรกเฉลี่ย")
  );

  const chSeries = Object.keys(CH)
    .map((k) => ({ name: CH[k].label, color: CHART_COL[k], values: a.perChannel[k] || [] }))
    .filter((s) => s.values.some((v) => v > 0) || a.kpi.inbound === 0);
  const chTot = Object.keys(CH)
    .map((k) => ({ name: CH[k].label, color: CHART_COL[k], v: a.channelTotals[k] || 0 }))
    .sort((x, y) => y.v - x.v);

  const specs = [
    { wide: true, title: "ข้อความเข้าต่อวัน แยกตามช่องทาง", sub: `${a.days} วันล่าสุด`,
      spec: { kind: "stack", cats: a.labels, series: chSeries, catHeader: "วัน" } },
    { title: "บอทกับพนักงาน ใครตอบมากกว่า", sub: "จำนวนข้อความที่ตอบต่อวัน",
      spec: { kind: "line", cats: a.labels, series: [{ name: "บอทตอบ", color: BOT_COL, values: a.botPerDay }, { name: "พนักงานตอบ", color: STAFF_COL, values: a.agentPerDay }], catHeader: "วัน" } },
    { title: "ช่องทางที่ลูกค้าทักมากที่สุด", sub: `ข้อความเข้ารวม ${a.days} วัน`,
      spec: { kind: "hbar", cats: chTot.map((x) => x.name), series: [{ name: "ข้อความเข้า", color: BOT_COL, values: chTot.map((x) => x.v) }], catColors: chTot.map((x) => x.color), catHeader: "ช่องทาง" } },
    { wide: true, title: "ลูกค้าทักช่วงเวลาไหน", sub: "ข้อความเข้าแยกตามชั่วโมง ใช้วางเวรพนักงาน",
      spec: { kind: "stack", cats: a.hours.map((_, i) => String(i).padStart(2, "0")), tips: a.hours.map((_, i) => `${String(i).padStart(2, "0")}:00–${String(i).padStart(2, "0")}:59 น.`), series: [{ name: "ข้อความเข้า", color: "#0F766E", values: a.hours }], every: 3, peak: true, catHeader: "ชั่วโมง" } },
  ];

  const holders = specs.map((c) => {
    c.spec.title = c.title;
    const body = el("div", { style: "display:flex;flex-direction:column;gap:10px" });
    return { c, body, sec: el("section", { class: "cc" + (c.wide ? " wide" : "") }, el("h2", {}, c.title), c.sub ? el("p", {}, c.sub) : null, body) };
  });
  $("#charts").replaceChildren(...holders.map((x) => x.sec));
  holders.forEach(({ c, body }) => {
    if (d.table) Charts.table(body, c.spec);
    else {
      c.spec.width = Math.max(300, Math.round(body.getBoundingClientRect().width));
      Charts.render(body, c.spec);
    }
  });
}

/* ---------- render ---------- */
function render() {
  $("#view-inbox").classList.toggle("chat", !!state.chat);
  const waiting = state.conversations.filter(needsStaff).length;
  const rb = $("#railbadge");
  rb.textContent = waiting;
  rb.hidden = !waiting;
  rb.setAttribute("aria-label", `รอพนักงาน ${waiting} ราย`);
  const ws = state.user ? state.user.workspace : "Social Media Chatbot Hub";
  document.title = (waiting ? `(${waiting}) ` : "") + ws + " · Hub";

  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("on", v.id === "view-" + state.view));
  document.querySelectorAll(".rail .rb").forEach((b) => b.classList.toggle("on", b.dataset.view === state.view));

  if (state.view === "inbox") {
    const keep = document.activeElement && document.activeElement.id === "q";
    renderChips();
    renderList();
    renderConv();
    renderSide();
    if (keep) $("#q").focus();
  }
  if (state.view === "kb") { renderKB(); renderKbTest(); }
  if (state.view === "channels") renderChannels();
  if (state.view === "settings") renderSettings();
  if (state.view === "api") { renderApi(); renderLog(); }
  if (state.view === "dash") renderDash();
}

function switchView(view) {
  // กดแท็บกล่องข้อความบนมือถือ = กลับไปหน้ารายการแชท ไม่ใช่ค้างอยู่ในห้องแชทเดิม
  if (view === "inbox") state.chat = false;
  state.view = view;
  Charts.hideTip();
  render();
  if (view === "inbox") loadInbox();
  if (view === "kb") loadDocuments();
  if (view === "channels") loadChannels();
  if (view === "settings") loadSettings();
  if (view === "api") { loadSettings(); loadEvents(); }
  if (view === "dash") loadAnalytics();
}

/* ---------- auth screen ---------- */
let signupMode = false;
function showAuth() {
  $("#app").style.display = "none";
  $("#auth").hidden = false;
  $("#aemail").focus();
  if (es) { es.close(); es = null; }
}
function setAuthMode(on) {
  signupMode = on;
  $("#authtitle").textContent = on ? "สมัครสมาชิก" : "เข้าสู่ระบบ";
  $("#asubmit").textContent = on ? "สมัครสมาชิก" : "เข้าสู่ระบบ";
  $("#atoggle").textContent = on ? "มีบัญชีแล้ว? เข้าสู่ระบบ" : "ยังไม่มีบัญชี? สมัครสมาชิก";
  $("#signupfields").style.display = on ? "flex" : "none";
  $("#apass").setAttribute("autocomplete", on ? "new-password" : "current-password");
  $("#aerr").textContent = "";
}

/* ---------- จำลองข้อความลูกค้า ---------- */
function openSimulate() {
  const connected = state.connections.filter((c) => c.status === "CONNECTED");
  if (!connected.length) {
    toast("ต้องเชื่อมช่องทางอย่างน้อย 1 ช่องก่อน");
    switchView("channels");
    return;
  }
  const err = el("div", { class: "aerr", role: "alert" });
  const sel = el("select", { class: "field", id: "s_ch", "aria-label": "ช่องทาง" },
    ...connected.map((c) => el("option", { value: c.channel }, `${CH[c.channel].label} · ${c.accountName}`)));
  const who = el("input", { class: "field", id: "s_who", value: "ลูกค้าทดสอบ", "aria-label": "ชื่อลูกค้า" });
  const text = el("textarea", { class: "field", rows: "3", id: "s_text", style: "height:auto;padding:10px 14px;width:100%", "aria-label": "ข้อความ" });
  text.value = "ค่าส่งเท่าไหร่คะ ส่งกี่วัน";
  const submit = el("button", { class: "btn pri", type: "submit" }, "ส่งเข้าระบบ");

  const form = el("form", { novalidate: true, style: "display:flex;flex-direction:column;gap:14px" },
    el("p", { style: "margin:0;color:var(--muted);font-size:13px" }, "ข้อความจะเดินผ่านขั้นตอนเดียวกับข้อความจริงทุกขั้น ต่างแค่ไม่ได้มาจากแพลตฟอร์ม ถ้าบอทตอบ ระบบจะพยายามส่งออกไปจริง"),
    el("label", { class: "f" }, "ช่องทาง", sel),
    el("label", { class: "f" }, "ชื่อลูกค้า", who),
    el("label", { class: "f" }, "ข้อความ", text),
    err,
    btnrow(el("button", { class: "btn", type: "button", onclick: closeModal }, "ยกเลิก"), submit));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    submit.disabled = true;
    submit.textContent = "กำลังส่ง…";
    try {
      await API.simulate({
        channel: sel.value,
        text: text.value.trim(),
        contactExternalId: "sim-" + who.value.trim(),
        contactName: who.value.trim(),
      });
      closeModal();
      toast("ส่งข้อความจำลองแล้ว");
      setTimeout(loadInbox, 900);
    } catch (ex) {
      err.textContent = ex.message;
      submit.disabled = false;
      submit.textContent = "ส่งเข้าระบบ";
    }
  });
  openModal("จำลองข้อความลูกค้า", form);
}

/* ---------- events ---------- */
document.querySelectorAll(".rail .rb").forEach((b) => b.addEventListener("click", () => switchView(b.dataset.view)));
$("#q").addEventListener("input", (e) => { state.q = e.target.value; renderList(); });
$("#simulate").addEventListener("click", openSimulate);
$("#mclose").addEventListener("click", closeModal);
$("#modal").addEventListener("mousedown", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#modal").hidden) closeModal(); });
$("#atoggle").addEventListener("click", () => setAuthMode(!signupMode));
$("#logout").addEventListener("click", () => guard(async () => { await API.logout(); location.reload(); }));
$("#file").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  toast(`กำลังอัปโหลด ${files.length} ไฟล์…`);
  const r = await guard(() => API.uploadDocuments(files));
  if (!r) return;
  loadDocuments();
  // กันกรณีเหตุการณ์ realtime มาถึงระหว่างที่รายการยังโหลดไม่เสร็จ
  setTimeout(loadDocuments, 1500);
  setTimeout(loadDocuments, 4000);
});
document.querySelectorAll("[data-range]").forEach((b) =>
  b.addEventListener("click", () => { state.dash.range = Number(b.dataset.range); Charts.hideTip(); loadAnalytics(); }));
$("#dtable").addEventListener("click", () => { state.dash.table = !state.dash.table; Charts.hideTip(); render(); });

let resizeT = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (state.view === "dash" && state.analytics) renderDash(); }, 150);
});

$("#authform").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#asubmit");
  btn.disabled = true;
  $("#aerr").textContent = "";
  try {
    const email = $("#aemail").value.trim();
    const password = $("#apass").value;
    if (signupMode) await API.signup({ name: $("#aname").value.trim(), workspace: $("#awork").value.trim() || undefined, email, password });
    else await API.login(email, password);
    location.reload();
  } catch (err) {
    $("#aerr").textContent = err.message;
    btn.disabled = false;
  }
});

/* ---------- inbox column resize ---------- */
(function inboxResize() {
  const inbox = document.getElementById("view-inbox");
  const KEY = "hub.inbox.widths";
  const bounds = { list: [240, 560], side: [220, 480] };
  const convMin = 320;
  const prop = { list: "--list-w", side: "--side-w" };
  const sel = { list: ".list", side: ".side" };
  function saved() {
    try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch (e) { return null; }
  }
  function apply(w) {
    if (!w) return;
    if (w.list) inbox.style.setProperty(prop.list, w.list + "px");
    if (w.side) inbox.style.setProperty(prop.side, w.side + "px");
  }
  function widthOf(target) {
    return Math.round(inbox.querySelector(sel[target]).getBoundingClientRect().width);
  }
  function sideOpen() {
    return getComputedStyle(inbox.querySelector(".side")).display !== "none";
  }
  function clamp(target, next) {
    const min = bounds[target][0];
    const max = bounds[target][1];
    const listW = target === "list" ? next : widthOf("list");
    const sideW = target === "side" ? next : (sideOpen() ? widthOf("side") : 0);
    const other = target === "list" ? sideW : listW;
    const room = inbox.getBoundingClientRect().width - other - convMin - 8;
    return Math.max(min, Math.min(max, next, Math.floor(room)));
  }
  function setWidth(target, px) {
    const n = clamp(target, px);
    inbox.style.setProperty(prop[target], n + "px");
    return n;
  }
  function persist() {
    const prev = saved() || {};
    localStorage.setItem(KEY, JSON.stringify({
      list: widthOf("list"),
      side: sideOpen() ? widthOf("side") : (prev.side || 300),
    }));
  }
  function bind(el, target, sign) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startW = widthOf(target);
      el.classList.add("drag");
      document.body.classList.add("col-drag");
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ตัวชี้สังเคราะห์ไม่มี pointer จริง */ }
      const move = (ev) => setWidth(target, Math.round(startW + (ev.clientX - startX) * sign));
      const up = () => {
        el.removeEventListener("pointermove", move);
        el.removeEventListener("pointerup", up);
        el.removeEventListener("pointercancel", up);
        el.classList.remove("drag");
        document.body.classList.remove("col-drag");
        persist();
      };
      el.addEventListener("pointermove", move);
      el.addEventListener("pointerup", up);
      el.addEventListener("pointercancel", up);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const step = e.shiftKey ? 48 : 16;
      const dir = e.key === "ArrowRight" ? 1 : -1;
      setWidth(target, widthOf(target) + dir * sign * step);
      persist();
    });
    el.addEventListener("dblclick", () => {
      inbox.style.removeProperty(prop[target]);
      const prev = saved() || {};
      delete prev[target];
      if (prev.list || prev.side) localStorage.setItem(KEY, JSON.stringify(prev));
      else localStorage.removeItem(KEY);
    });
  }
  apply(saved());
  bind(document.getElementById("split-list"), "list", 1);
  bind(document.getElementById("split-side"), "side", -1);
})();

/* ---------- start ---------- */
(async function start() {
  setAuthMode(false);
  let me = null;
  try {
    me = await API.me();
  } catch (err) {
    if (err instanceof ApiError && err.status === 0) {
      $("#aerr").textContent = err.message;
    }
  }
  if (!me) {
    showAuth();
    return;
  }
  state.user = me.user;
  $("#auth").hidden = true;
  $("#app").style.display = "";
  $("#logout").textContent = (state.user.name || state.user.email).charAt(0).toUpperCase();
  $("#logout").title = "ออกจากระบบ (" + state.user.email + ")";

  render();
  startStream();
  await Promise.all([loadInbox(), loadChannels()]);
})();
