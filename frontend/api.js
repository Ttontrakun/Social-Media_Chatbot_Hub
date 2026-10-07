"use strict";
/*
 * ชั้นเรียก API ของ backend
 * ทุกคำขอแนบ cookie ของเซสชันไปด้วย (credentials: same-origin)
 * ไม่มีการเก็บรหัสผ่านหรือ token ไว้ในเบราว์เซอร์
 */
(function () {
  const BASE = "/api";

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function request(path, { method = "GET", body, form } = {}) {
    let res;
    try {
      res = await fetch(BASE + path, {
        method,
        credentials: "same-origin",
        headers: form || body === undefined ? {} : { "content-type": "application/json" },
        body: form ? form : body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new ApiError("ติดต่อเซิร์ฟเวอร์ไม่ได้ ตรวจสอบว่า backend ทำงานอยู่", 0);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* ไม่ใช่ JSON */
    }
    if (!res.ok) throw new ApiError((json && json.error) || `เซิร์ฟเวอร์ตอบ ${res.status}`, res.status);
    return json;
  }

  window.ApiError = ApiError;
  window.API = {
    health: () => request("/health"),

    // บัญชีผู้ใช้
    me: () => request("/auth/me"),
    login: (email, password) => request("/auth/login", { method: "POST", body: { email, password } }),
    signup: (info) => request("/auth/signup", { method: "POST", body: info }),
    logout: () => request("/auth/logout", { method: "POST" }),

    // กล่องข้อความ
    conversations: () => request("/conversations"),
    conversation: (id) => request("/conversations/" + id),
    sendMessage: (id, text) => request(`/conversations/${id}/messages`, { method: "POST", body: { text } }),
    draft: (id) => request(`/conversations/${id}/draft`, { method: "POST" }),
    patchConversation: (id, data) => request("/conversations/" + id, { method: "PATCH", body: data }),
    setTags: (id, tags) => request(`/conversations/${id}/tags`, { method: "PATCH", body: { tags } }),
    simulate: (data) => request("/conversations/simulate", { method: "POST", body: data }),

    // ช่องทาง
    channels: () => request("/channels"),
    connectLine: (data) => request("/channels/line", { method: "POST", body: data }),
    connectManual: (data) => request("/channels/manual", { method: "POST", body: data }),
    patchChannel: (id, data) => request("/channels/" + id, { method: "PATCH", body: data }),
    disconnectChannel: (id) => request("/channels/" + id, { method: "DELETE" }),
    metaOAuthStart: () => request("/channels/meta/oauth/start"),

    // ฐานความรู้
    documents: () => request("/kb"),
    uploadDocuments: (files) => {
      const form = new FormData();
      for (const f of files) form.append("files", f, f.name);
      return request("/kb", { method: "POST", form });
    },
    deleteDocument: (id) => request("/kb/" + id, { method: "DELETE" }),
    testKb: (question) => request("/kb/test", { method: "POST", body: { question } }),

    // ตั้งค่าและ API key
    settings: () => request("/settings"),
    saveBot: (data) => request("/settings/bot", { method: "PATCH", body: data }),
    createApiKey: (name) => request("/settings/api-keys", { method: "POST", body: { name } }),
    patchApiKey: (id, data) => request("/settings/api-keys/" + id, { method: "PATCH", body: data }),
    deleteApiKey: (id) => request("/settings/api-keys/" + id, { method: "DELETE" }),
    events: () => request("/settings/events"),

    // แดชบอร์ด
    analytics: (days) => request("/analytics?days=" + days),

    /** รับเหตุการณ์แบบ realtime ผ่าน Server-Sent Events */
    stream(handlers) {
      const es = new EventSource(BASE + "/stream", { withCredentials: true });
      for (const [event, fn] of Object.entries(handlers)) es.addEventListener(event, fn);
      return es;
    },
  };
})();
