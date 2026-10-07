"use strict";
/*
 * กราฟ SVG แบบเบา ไม่พึ่งไลบรารีภายนอก
 * spec = { title, kind: "stack" | "line" | "hbar", cats: [...], tips?: [...], series: [{name,color,values}],
 *          catColors?: [...], fmt?: fn, every?: n, peak?: bool, unit?: string }
 * - stack: คอลัมน์ซ้อน (ซีรีส์เดียวก็ใช้ได้)  - line: เส้น + crosshair  - hbar: แท่งแนวนอน (ซ้อนได้)
 */
(function () {
  var NS = "http://www.w3.org/2000/svg";
  var INK = "#18212D", MUTED = "#5A6676", GRID = "#E4E8ED", SURFACE = "#FFFFFF", HOVER = "#EEF2F6";

  function s(tag, attrs) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    }
    return e;
  }
  function h(tag, props) {
    var e = document.createElement(tag);
    for (var k in (props || {})) e.setAttribute(k, props[k]);
    for (var i = 2; i < arguments.length; i++) {
      var c = arguments[i];
      if (c != null) e.append(c.nodeType ? c : document.createTextNode(c));
    }
    return e;
  }
  function defaultFmt(n) { return Math.round(n).toLocaleString("en-US"); }
  function nice(max, ticks) {
    ticks = ticks || 4;
    if (!(max > 0)) return { max: 1, step: 1 };
    var raw = max / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw))), norm = raw / mag;
    var step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    return { max: Math.ceil(max / step - 1e-9) * step, step: step };
  }
  function roundedTop(x, y, w, hgt, r) {
    r = Math.min(r, w / 2, hgt);
    return "M" + x + "," + (y + hgt) + "L" + x + "," + (y + r) + "Q" + x + "," + y + " " + (x + r) + "," + y +
      "L" + (x + w - r) + "," + y + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) + "L" + (x + w) + "," + (y + hgt) + "Z";
  }
  function roundedRight(x, y, w, hgt, r) {
    r = Math.min(r, w, hgt / 2);
    return "M" + x + "," + y + "L" + (x + w - r) + "," + y + "Q" + (x + w) + "," + y + " " + (x + w) + "," + (y + r) +
      "L" + (x + w) + "," + (y + hgt - r) + "Q" + (x + w) + "," + (y + hgt) + " " + (x + w - r) + "," + (y + hgt) +
      "L" + x + "," + (y + hgt) + "Z";
  }

  /* ---------- tooltip (ใช้ textContent เสมอ) ---------- */
  var tip = null;
  function ensureTip() {
    if (!tip) { tip = h("div", { "class": "charttip", "aria-hidden": "true" }); document.body.append(tip); }
    return tip;
  }
  function showTip(pt, title, rows, kind) {
    var t = ensureTip();
    t.replaceChildren(h("div", { "class": "tt-title" }, title));
    rows.forEach(function (r) {
      var key = h("span", { "class": "tt-key" + (kind === "line" ? " line" : ""), style: "background:" + r.color });
      t.append(h("div", { "class": "tt-row" }, key, h("b", {}, r.value), h("span", {}, r.label)));
    });
    t.style.display = "block";
    var w = t.offsetWidth, hh = t.offsetHeight, x = pt.x + 14, y = pt.y - hh - 10;
    if (x + w > window.innerWidth - 8) x = pt.x - w - 14;
    if (x < 8) x = 8;
    if (y < 8) y = pt.y + 16;
    t.style.left = x + "px"; t.style.top = y + "px";
  }
  function hideTip() { if (tip) tip.style.display = "none"; }
  function rectCenter(el) { var r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 3 }; }

  function legend(spec, kind) {
    if (spec.series.length < 2) return null;
    var box = h("div", { "class": "legend" });
    spec.series.forEach(function (sr) {
      box.append(h("span", { "class": "lg" }, h("i", { "class": kind === "line" ? "lk" : "sw", style: "background:" + sr.color }), sr.name));
    });
    return box;
  }

  /* ---------- คอลัมน์ซ้อน ---------- */
  function vbars(spec) {
    var fmt = spec.fmt || defaultFmt;
    var W = spec.width || 640, H = 250, pl = 40, pr = 8, pt = 16, pb = 26, n = spec.cats.length;
    var totals = spec.cats.map(function (_, i) { return spec.series.reduce(function (a, x) { return a + x.values[i]; }, 0); });
    var sc = nice(Math.max.apply(null, totals)), max = sc.max;
    var pw = W - pl - pr, ph = H - pt - pb, band = pw / n, bw = Math.min(24, band * 0.62);
    var y = function (v) { return pt + ph - (v / max) * ph; };
    var svg = s("svg", { viewBox: "0 0 " + W + " " + H, "class": "chart", role: "img", "aria-label": spec.title + " (ดูตัวเลขได้ในโหมดตาราง)" });
    for (var v = 0; v <= max + 1e-9; v += sc.step) {
      svg.append(s("line", { x1: pl, x2: W - pr, y1: y(v), y2: y(v), stroke: GRID, "stroke-width": 1 }));
      svg.append(s("text", { x: pl - 6, y: y(v) + 4, "text-anchor": "end", "font-size": 11, fill: MUTED }, fmt(v)));
    }
    var every = spec.every || Math.ceil(n / 8), peakIdx = totals.indexOf(Math.max.apply(null, totals));
    spec.cats.forEach(function (c, i) {
      var cx = pl + band * i + band / 2, x0 = cx - bw / 2;
      var bg = s("rect", { x: pl + band * i, y: pt, width: band, height: ph, fill: HOVER, opacity: 0 });
      svg.append(bg);
      var acc = 0, topK = -1;
      spec.series.forEach(function (sr, k) { if (sr.values[i] > 0) topK = k; });
      spec.series.forEach(function (sr, k) {
        var val = sr.values[i];
        if (val <= 0) return;
        var y1 = y(acc + val), y2 = y(acc), gap = acc > 0 ? 2 : 0, hgt = Math.max(1, y2 - y1 - gap);
        acc += val;
        if (k === topK) svg.append(s("path", { d: roundedTop(x0, y1, bw, hgt, 4), fill: sr.color }));
        else svg.append(s("rect", { x: x0, y: y1, width: bw, height: hgt, fill: sr.color }));
      });
      if (i % every === 0 || i === n - 1 && n - 1 - (Math.floor((n - 1) / every) * every) >= every * 0.6) {
        svg.append(s("text", { x: cx, y: H - 8, "text-anchor": "middle", "font-size": 11, fill: MUTED }, c));
      }
      if (spec.peak && i === peakIdx) {
        svg.append(s("text", { x: cx, y: y(totals[i]) - 6, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: INK }, fmt(totals[i])));
      }
      var title = (spec.tips && spec.tips[i]) || c;
      var rows = spec.series.slice().reverse().map(function (sr) { return { color: sr.color, label: sr.name, value: fmt(sr.values[i]) }; });
      if (spec.series.length > 1) rows.push({ color: "transparent", label: "รวม", value: fmt(totals[i]) });
      var hit = s("rect", { x: pl + band * i, y: pt, width: band, height: ph, fill: "transparent", tabindex: 0, role: "img",
        "aria-label": title + ": " + rows.map(function (r) { return r.label + " " + r.value; }).join(", ") });
      var on = function (pt2) { bg.setAttribute("opacity", 1); showTip(pt2, title, rows); };
      var off = function () { bg.setAttribute("opacity", 0); hideTip(); };
      hit.addEventListener("pointermove", function (e) { on({ x: e.clientX, y: e.clientY }); });
      hit.addEventListener("pointerleave", off);
      hit.addEventListener("focus", function () { on(rectCenter(hit)); });
      hit.addEventListener("blur", off);
      svg.append(hit);
    });
    return svg;
  }

  /* ---------- เส้น ---------- */
  function lineChart(spec) {
    var fmt = spec.fmt || defaultFmt;
    var W = spec.width || 640, H = 250, pl = 40, pr = 12, pt = 16, pb = 26, n = spec.cats.length;
    var all = [].concat.apply([], spec.series.map(function (x) { return x.values; }));
    var sc = nice(Math.max.apply(null, all)), max = sc.max;
    var pw = W - pl - pr, ph = H - pt - pb, band = pw / n;
    var X = function (i) { return pl + band * i + band / 2; }, Y = function (v) { return pt + ph - (v / max) * ph; };
    var svg = s("svg", { viewBox: "0 0 " + W + " " + H, "class": "chart", role: "img", tabindex: 0,
      "aria-label": spec.title + " (กดลูกศรซ้ายขวาเพื่อดูแต่ละวัน หรือดูตัวเลขในโหมดตาราง)" });
    for (var v = 0; v <= max + 1e-9; v += sc.step) {
      svg.append(s("line", { x1: pl, x2: W - pr, y1: Y(v), y2: Y(v), stroke: GRID, "stroke-width": 1 }));
      svg.append(s("text", { x: pl - 6, y: Y(v) + 4, "text-anchor": "end", "font-size": 11, fill: MUTED }, fmt(v)));
    }
    var every = spec.every || Math.ceil(n / 8);
    spec.cats.forEach(function (c, i) {
      if (i % every === 0) svg.append(s("text", { x: X(i), y: H - 8, "text-anchor": "middle", "font-size": 11, fill: MUTED }, c));
    });
    var cross = s("line", { x1: 0, x2: 0, y1: pt, y2: pt + ph, stroke: "#9AA5B4", "stroke-width": 1, opacity: 0 });
    svg.append(cross);
    spec.series.forEach(function (sr) {
      var d = sr.values.map(function (val, i) { return (i ? "L" : "M") + X(i) + "," + Y(val); }).join("");
      svg.append(s("path", { d: d, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    });
    var last = n - 1;
    spec.series.forEach(function (sr) {
      svg.append(s("circle", { cx: X(last), cy: Y(sr.values[last]), r: 4, fill: sr.color, stroke: SURFACE, "stroke-width": 2 }));
    });
    var hov = spec.series.map(function (sr) {
      var c = s("circle", { cx: 0, cy: 0, r: 4, fill: sr.color, stroke: SURFACE, "stroke-width": 2, opacity: 0 });
      svg.append(c); return c;
    });
    var cur = -1;
    function at(i, pt2) {
      cur = Math.max(0, Math.min(n - 1, i));
      cross.setAttribute("x1", X(cur)); cross.setAttribute("x2", X(cur)); cross.setAttribute("opacity", 1);
      spec.series.forEach(function (sr, k) { hov[k].setAttribute("cx", X(cur)); hov[k].setAttribute("cy", Y(sr.values[cur])); hov[k].setAttribute("opacity", 1); });
      var rows = spec.series.map(function (sr) { return { color: sr.color, label: sr.name, value: fmt(sr.values[cur]) }; });
      var r = svg.getBoundingClientRect();
      showTip(pt2 || { x: r.left + X(cur) * r.width / W, y: r.top + 40 }, (spec.tips && spec.tips[cur]) || spec.cats[cur], rows, "line");
    }
    function off() {
      cur = -1; cross.setAttribute("opacity", 0); hov.forEach(function (c) { c.setAttribute("opacity", 0); }); hideTip();
    }
    var overlay = s("rect", { x: pl, y: pt, width: pw, height: ph, fill: "transparent" });
    overlay.addEventListener("pointermove", function (e) {
      var r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * W / r.width;
      at(Math.round((mx - pl - band / 2) / band), { x: e.clientX, y: e.clientY });
    });
    overlay.addEventListener("pointerleave", off);
    svg.append(overlay);
    svg.addEventListener("keydown", function (e) {
      if (e.key === "ArrowRight") { e.preventDefault(); at(cur < 0 ? 0 : cur + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); at(cur < 0 ? n - 1 : cur - 1); }
      else if (e.key === "Escape") off();
    });
    svg.addEventListener("blur", off);
    return svg;
  }

  /* ---------- แท่งแนวนอน (ซ้อนได้) ---------- */
  function hbars(spec) {
    var fmt = spec.fmt || defaultFmt;
    var W = spec.width || 640, pl = Math.min(150, Math.round((spec.width || 640) * 0.4)), rowH = 36, bt = 18, pt = 6, n = spec.cats.length, H = pt + n * rowH + 6, valW = 56;
    var totals = spec.cats.map(function (_, i) { return spec.series.reduce(function (a, x) { return a + x.values[i]; }, 0); });
    var max = Math.max.apply(null, totals) || 1, X = function (v) { return (v / max) * (W - pl - valW); };
    var svg = s("svg", { viewBox: "0 0 " + W + " " + H, "class": "chart", role: "img", "aria-label": spec.title + " (ดูตัวเลขได้ในโหมดตาราง)" });
    svg.append(s("line", { x1: pl, x2: pl, y1: pt, y2: H - 6, stroke: GRID, "stroke-width": 1 }));
    spec.cats.forEach(function (c, i) {
      var y0 = pt + i * rowH + (rowH - bt) / 2;
      var bg = s("rect", { x: 0, y: pt + i * rowH, width: W, height: rowH, fill: HOVER, opacity: 0, rx: 6 });
      svg.append(bg);
      svg.append(s("text", { x: pl - 10, y: y0 + bt / 2 + 4, "text-anchor": "end", "font-size": 12, fill: INK }, c));
      var acc = 0, topK = -1;
      spec.series.forEach(function (sr, k) { if (sr.values[i] > 0) topK = k; });
      spec.series.forEach(function (sr, k) {
        var val = sr.values[i];
        if (val <= 0) return;
        var col = spec.catColors && spec.series.length === 1 ? spec.catColors[i] : sr.color;
        var x1 = pl + X(acc) + (acc > 0 ? 2 : 0), w = Math.max(1, X(acc + val) - X(acc) - (acc > 0 ? 2 : 0));
        acc += val;
        if (k === topK) svg.append(s("path", { d: roundedRight(x1, y0, w, bt, 4), fill: col }));
        else svg.append(s("rect", { x: x1, y: y0, width: w, height: bt, fill: col }));
      });
      svg.append(s("text", { x: pl + X(totals[i]) + 8, y: y0 + bt / 2 + 4, "font-size": 12, "font-weight": 600, fill: INK }, fmt(totals[i])));
      var rows = spec.series.map(function (sr, k) {
        return { color: spec.catColors && spec.series.length === 1 ? spec.catColors[i] : sr.color, label: sr.name, value: fmt(sr.values[i]) };
      });
      var hit = s("rect", { x: 0, y: pt + i * rowH, width: W, height: rowH, fill: "transparent", tabindex: 0, role: "img",
        "aria-label": c + ": " + rows.map(function (r) { return r.label + " " + r.value; }).join(", ") });
      var on = function (pt2) { bg.setAttribute("opacity", 1); showTip(pt2, c, rows); };
      var off = function () { bg.setAttribute("opacity", 0); hideTip(); };
      hit.addEventListener("pointermove", function (e) { on({ x: e.clientX, y: e.clientY }); });
      hit.addEventListener("pointerleave", off);
      hit.addEventListener("focus", function () { on(rectCenter(hit)); });
      hit.addEventListener("blur", off);
      svg.append(hit);
    });
    return svg;
  }

  /* ---------- ตาราง (ทางเลือกแทนกราฟ) ---------- */
  function table(box, spec) {
    var fmt = spec.fmt || defaultFmt;
    box.replaceChildren();
    var tb = h("table", { "class": "dt" });
    tb.append(h("caption", { "class": "sr" }, spec.title));
    var hr = h("tr", {}, h("th", { scope: "col" }, spec.catHeader || "รายการ"));
    spec.series.forEach(function (sr) { hr.append(h("th", { scope: "col" }, sr.name)); });
    if (spec.series.length > 1) hr.append(h("th", { scope: "col" }, "รวม"));
    tb.append(h("thead", {}, hr));
    var body = h("tbody");
    spec.cats.forEach(function (c, i) {
      var tr = h("tr", {}, h("th", { scope: "row" }, (spec.tips && spec.tips[i]) || c));
      var tot = 0;
      spec.series.forEach(function (sr) { tot += sr.values[i]; tr.append(h("td", {}, fmt(sr.values[i]))); });
      if (spec.series.length > 1) tr.append(h("td", {}, fmt(tot)));
      body.append(tr);
    });
    tb.append(body);
    box.append(h("div", { "class": "dt-wrap" }, tb));
  }

  function render(box, spec) {
    box.replaceChildren();
    var lg = legend(spec, spec.kind);
    if (lg) box.append(lg);
    var svg = spec.kind === "line" ? lineChart(spec) : spec.kind === "hbar" ? hbars(spec) : vbars(spec);
    box.append(svg);
  }

  window.Charts = { render: render, table: table, hideTip: hideTip };
})();
