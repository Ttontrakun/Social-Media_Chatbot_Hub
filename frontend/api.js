"use strict";
/*
 * ชั้นเรียกข้อมูลของ frontend
 * ตอนนี้เป็นตัวจำลองที่เก็บใน localStorage ของเบราว์เซอร์
 * เมื่อมี backend ให้เปลี่ยนเนื้อในฟังก์ชันเหล่านี้เป็น fetch("/api/...") โดยไม่ต้องแก้หน้า UI
 * ไม่มีการเก็บรหัสผ่าน, channel secret หรือ access token ที่ใดเลยในไฟล์นี้
 */
(function () {
  var USER_KEY = "hub.user.v1";
  var STATE_KEY = "hub.state.v1:";

  function safe(fn, fallback) {
    try { return fn(); } catch (e) { return fallback; }
  }
  function delay(value, ms) {
    return new Promise(function (resolve) { setTimeout(function () { resolve(value); }, ms || 300); });
  }
  function validate(email, password) {
    if (!email || email.indexOf("@") < 1) throw new Error("รูปแบบอีเมลไม่ถูกต้อง");
    if (!password || password.length < 6) throw new Error("รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร");
  }
  function setUser(u) { safe(function () { localStorage.setItem(USER_KEY, JSON.stringify(u)); }); return u; }

  window.API = {
    /* ---- auth (จำลอง: ไม่ตรวจรหัสผ่านจริง ไม่เก็บรหัสผ่าน) ---- */
    getUser: function () {
      return safe(function () { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); }, null);
    },
    login: function (email, password) {
      return delay(null).then(function () {
        validate(email, password);
        return setUser({ email: email, name: email.split("@")[0], workspace: "ร้านตัวอย่าง" });
      });
    },
    signup: function (info) {
      return delay(null).then(function () {
        validate(info.email, info.password);
        if (!info.name) throw new Error("กรุณากรอกชื่อ");
        return setUser({ email: info.email, name: info.name, workspace: info.workspace || "ร้านของฉัน" });
      });
    },
    logout: function () { safe(function () { localStorage.removeItem(USER_KEY); }); },

    /* ---- ข้อมูลแอป (แยกตามผู้ใช้) ---- */
    loadState: function () {
      var u = this.getUser();
      if (!u) return null;
      return safe(function () { return JSON.parse(localStorage.getItem(STATE_KEY + u.email) || "null"); }, null);
    },
    saveState: function (s) {
      var u = this.getUser();
      if (!u) return;
      safe(function () { localStorage.setItem(STATE_KEY + u.email, JSON.stringify(s)); });
    },
    resetState: function () {
      var u = this.getUser();
      if (!u) return;
      safe(function () { localStorage.removeItem(STATE_KEY + u.email); });
    },

    /* ---- webhook URL ที่ให้ผู้ใช้นำไปวางในแพลตฟอร์ม (ของจริงมาจาก backend) ---- */
    webhookUrl: function (channel) {
      return location.origin + "/webhooks/" + channel;
    }
  };
})();
