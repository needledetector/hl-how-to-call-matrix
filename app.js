
"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
// Use NFKC to convert half-width kana to full-width kana and normalize differences in width and size. The distinction between hiragana and katakana is preserved.
const norm  = s => s.normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
// Convert Katakana to Hiragana. This is because names are essentially phonetic transcriptions and often have spelling variations.
const toHira = s => s.replace(/[\u30a1-\u30f6\u30fd\u30fe]/g,
                              c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const normH = s => toHira(norm(s));
const hasHira = s => /[\u3041-\u3096]/.test(s);

const CW = {narrow:112, normal:132, wide:176};
const STATE_LABEL = {unsure:"※ 未確認", na:"離籍・未デビュー", omitted:"省略"};
const FLAG_LABEL = {main:"基本", rare:"稀", third:"三人称", egosa:"エゴサワード",
                    retired:"使用終了"};
const FLAG_MARK  = {main:"◎", rare:"*", third:"+", egosa:"☆"};   // Symbols are not supposed to be displayed for retired

/* ================= Spreadsheet Acquisition and Analysis ================= */
const SHEET_ID = "1Ux_YCAYC_HuaFQxwS5_uoT-zew0Z94gZtqDmUDMnnZc";
const SHEETS = {matrix:"呼称表", aux:"補助データ", axis:"軸マッピング"};
const gvizURL = (name, bust) =>
  "https://docs.google.com/spreadsheets/d/" + SHEET_ID +
  "/gviz/tq?tqx=out:csv&sheet=" + encodeURIComponent(name) + (bust ? "&_=" + Date.now() : "");

/* ---- CSV (RFC4180) ---- */
function parseCSV(text){
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++){
    const c = text[i];
    if (q){
      if (c === '"'){ if (text[i+1] === '"'){ f += '"'; i++; } else q = false; }
      else f += c;
    } else if (c === '"'){ q = true; }
    else if (c === ","){ row.push(f); f = ""; }
    else if (c === "\n"){ row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r"){ f += c; }
  }
  if (f !== "" || row.length){ row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ""));
}

/* ---- Symbols and Brackets ---- */
const FLAG_OF = {"◎":"main", "*":"rare", "+":"third", "☆":"egosa"};
const MARK_RE = /([◎*+☆]+)\s*$/;
const PAREN_RE = /[（(]([^）)]*)[）)]\s*$/;
const TIMECODE = /\d{1,2}:\d{2}(?::\d{2})?/;
const NA_SET = new Set(["在籍時未デビュー","デビュー時離籍済","登場時離籍済",
                        "活動中未登場","活動中未デビュー","在籍時未登場"]);

/* Break lines only outside of parentheses, brackets, and quotation marks */
function splitOutside(s, sep){
  sep = sep || "、";
  const out = []; let buf = "", depth = 0, quoted = false;
  for (const ch of s){
    if (ch === '"') quoted = !quoted;
    else if ("（(「『".includes(ch)) depth++;
    else if ("）)」』".includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === sep && depth === 0 && !quoted){ out.push(buf); buf = ""; }
    else buf += ch;
  }
  out.push(buf);
  return out.map(x => x.trim()).filter(Boolean);
}

/* Determine the state by checking all cells */
/* Parentheses at the beginning of a cell indicate a "note on relationships." Sometimes a specific title or way of addressing follows.
   Example: (Already departed at time of debut) Chairman Senpai+ ... Mentioning them in the third person is possible even after they have left. */
function cellState(raw){
  const s = raw.trim();
  if (s === "※") return {state:"unsure", reason:null, rest:""};
  const m = s.match(/^[（(]([^）)]*)[）)]\s*/);
  if (m){
    const inner = m[1].trim().replace(/^[「『]/, "").replace(/[」』]$/, "");
    const rest = s.slice(m[0].length).trim();
    if (inner === "省略") return {state:"omitted", reason:inner, rest};
    if (NA_SET.has(inner) || /離籍|未デビュー|卒業/.test(inner))
      return {state:"na", reason:inner, rest};
  }
  return {state:null, reason:null, rest:s};
}

function parseAppellation(part, flags){
  let t = part.trim();
  const notes = [];
  for (let k = 0; k < 4; k++){
    const before = t;
    let m = t.match(MARK_RE);
    if (m){ for (const ch of m[1]) flags[FLAG_OF[ch]] = true; t = t.slice(0, m.index).trimEnd(); }
    m = t.match(PAREN_RE);
    if (m){ notes.unshift(m[1]); t = t.slice(0, m.index).trimEnd(); }
    if (t === before) break;
  }
  if (!t && !notes.length) return null;
  const tags = [], times = [];
  for (const n of notes)
    for (const piece of splitOutside(n.normalize("NFKC")))
      for (let tag of piece.split(/[、/／]/)){
        tag = tag.trim();
        if (!tag) continue;
        if (TIMECODE.test(tag)) times.push(tag);
        tags.push(tag);
      }
  return {label:t, key:norm(t), tags, times};
}

/* Split the cell using "←". The left side shows active items, and the right side shows discontinued items. Maintain the current order as they are sorted by frequency. */
function parseCell(raw){
  const out = [];
  raw.split(/←|<-/).forEach((seg, gi) => {
    for (const tokRaw of splitOutside(seg)){
      const flags = {main:false, rare:false, third:false, egosa:false};
      const a = parseAppellation(tokRaw, flags);
      if (!a) continue;
      a.flags = Object.keys(flags).filter(k => flags[k]);
      if (gi > 0 || a.tags.includes("旧")) a.flags.push("retired");
      out.push(a);
    }
  });
  return out;
}

/* ---- Assemble the final form from 3 sheets ---- */
function pick(header, ...names){
  for (const n of names){
    const i = header.findIndex(h => (h || "").trim() === n);
    if (i >= 0) return i;
  }
  return -1;
}

function build(mRows, auxRows, axisRows, warn0){
  const legend = mRows[0][0] || "";
  let cols = mRows[0].slice(1);
  while (cols.length && !cols[cols.length - 1].trim()) cols.pop();
  const nCol = cols.length;
  const body = mRows.slice(1).filter(r => (r[0] || "").trim());
  const names = body.map(r => r[0].replace(/\n/g, " ").trim());

  // Supplemental data: Look up by "header" instead of cell position. Use the ID column if it exists.
  const aux = new Map();
  if (auxRows.length > 1 && pick(auxRows[0], "人物", "名前", "キャラ", "キャラクター") < 0){
    warn.push("補助データに人物列がありません");
    auxRows = [];
  }
  if (auxRows.length > 1){
    const h = auxRows[0];
    const ci = {
      name: pick(h, "人物", "名前", "キャラ", "キャラクター"),
      id:   pick(h, "id", "ID", "Id"),
      proj: pick(h, "グループ", "プロジェクト"),
      gen:  pick(h, "期生"),
      gen2: pick(h, "期生兼"),
      emo:  pick(h, "絵文字"),
      abbr: pick(h, "略称", "略", "短縮名", "短縮"),
    };
    for (const r of auxRows.slice(1)){
      const nm = (r[ci.name >= 0 ? ci.name : 0] || "").trim();
      if (!nm) continue;
      aux.set(nm, {
        id:      ci.id   >= 0 ? (r[ci.id] || "").trim() : "",
        project: ci.proj >= 0 ? (r[ci.proj] || "").trim() : "",
        gens:    [ci.gen, ci.gen2].filter(i => i >= 0).map(i => (r[i] || "").trim()).filter(Boolean),
        emoji:   ci.emo  >= 0 ? (r[ci.emo] || "").trim() : "",
        abbr:    ci.abbr >= 0 ? (r[ci.abbr] || "").trim() : "",
      });
    }
  }

  // Axis mapping: Tag / Axis / Display Name. If there are too many columns, it is determined that a different sheet is being used and an error occurs.
  const axes = {};
  if (axisRows.length && Math.max(...axisRows.slice(0, 5).map(r => r.length)) > 4){
    warn.push("軸マッピングの形が違います（列が多すぎます）。軸チップは出ません");
    axisRows = [];
  }
  for (const r of axisRows){
    const tag = (r[0] || "").trim(), axis = (r[1] || "").trim();
    if (!tag || !axis || tag.startsWith("#") || tag === "タグ") continue;
    axes[tag.normalize("NFKC")] = {axis, label: (r[2] || "").trim() || tag};
  }

  const idOf = nm => {
    const a = aux.get(nm);
    return (a && a.id) ? a.id : nm;   // If the id column does not exist, use the display name as is.
  };

  const chars = names.map(nm => {
    const a = aux.get(nm) || {};
    return {id: idOf(nm), name: nm, key: norm(nm), emoji: a.emoji || null,
            abbr: a.abbr || null, project: a.project || null,
            gens: a.gens || [], known: aux.has(nm)};
  });

  const cells = [];
  const warn = (warn0 || []).slice();
  if (nCol !== names.length)
    warn.push("行 " + names.length + " 件に対し列 " + nCol + " 件。数が合っていません");
  // The rows and columns refer to the same people in the same order. Map them by position, as using names would break due to notation inconsistencies.
  const drift = [];
  for (let j = 0; j < Math.min(nCol, names.length); j++){
    const cn = cols[j].replace(/\n/g, " ").trim();
    if (cn !== names[j]) drift.push(names[j] + " / " + cn);
  }
  if (drift.length)
    warn.push("行と列の見出しが " + drift.length + " 件ずれています: " + drift.slice(0, 3).join("、"));

  names.forEach((rn, i) => {
    const row = body[i];
    for (let j = 0; j < nCol; j++){
      const raw = (row[j + 1] || "").replace(/\n/g, " ");
      if (!raw.trim()) continue;
      const f = chars[i].id, t = (chars[j] || {}).id;
      if (t === undefined) continue;
      const st = cellState(raw);
      const cell = {f, t};
      if (st.state){ cell.s = st.state; if (st.reason) cell.r = st.reason; }
      const apps = [];
      for (const tok of (st.rest ? parseCell(st.rest) : [])){
        const ax = {};
        for (const tag of tok.tags){
          const hit = axes[tag];
          if (hit){ (ax[hit.axis] = ax[hit.axis] || []).push(hit.label); }
        }
        const a = {l: tok.label};
        if (tok.key !== tok.label) a.k = tok.key;
        if (tok.flags.length) a.g = tok.flags;
        if (tok.tags.length) a.n = tok.tags;
        if (Object.keys(ax).length) a.x = ax;
        if (tok.times.length) a.src = tok.times;
        apps.push(a);
      }
      if (apps.length) cell.a = apps;
      if (cell.s || cell.a) cells.push(cell);
    }
  });
  if (!Object.keys(axes).length && !warn.some(w => w.indexOf("軸マッピング") >= 0))
    warn.push("軸マッピングが空です");
  return {version:2, legend, chars, cells, axes, warn};
}

async function fetchSheet(name, bust){
  const res = await fetch(gvizURL(name, bust));
  if (!res.ok) throw new Error(name + " の取得に失敗 (" + res.status + ")");
  return parseCSV(await res.text());
}

async function loadData(bust){
  const [m, a, x] = await Promise.all([
    fetchSheet(SHEETS.matrix, bust),
    fetchSheet(SHEETS.aux, bust).catch(() => []),
    fetchSheet(SHEETS.axis, bust).catch(() => []),
  ]);
  // If a sheet= name is not provided, gviz will silently return the first sheet. If the content matches the first sheet, it considers the referenced sheet to be "non-existent."
  const sig = r => (r[0] || []).join("\u0001");
  const base = sig(m), warn = [];
  let aux = a, axis = x;
  if (a.length && sig(a) === base){
    warn.push("「" + SHEETS.aux + "」シートが見つかりません");
    aux = [];
  }
  if (x.length && sig(x) === base){
    warn.push("「" + SHEETS.axis + "」シートが見つかりません");
    axis = [];
  }
  return build(m, aux, axis, warn);
}

let D = null, cellMap = new Map(), byId = new Map();
let booted = false, srcNote = "";
const hidden  = new Set();     // Hidden character IDs
const selCell = new Map();     // Cell status     → "only" | "not"
const selFlag = new Map();     // Name flag       → "only" | "not"
const selAxis = new Map();     // "Axis:Value"    → "only" | "not"
// Cycles through Unselected → Limited → Excluded → Unselected with each tap
const cycle = (m, k) => {
  const v = m.get(k);
  if (!v) m.set(k, "only"); else if (v === "only") m.set(k, "not"); else m.delete(k);
};
const attr = s => String(s).replace(/["\\]/g, "\\$&");   // For attribute selector strings
let mode = "dim", clip = 5, cw = "normal", autoHide = false, panelH = null, useShort = true;

/* ================= Loading ================= */
function showMsg(html){ $("#msg").innerHTML = html; $("#msg").style.display = "grid"; }

async function start(bust){
  showMsg("スプレッドシートを読み込み中…");
  $("#sum").textContent = "読み込み中…";
  try{
    D = await loadData(bust);
    srcNote = "";
  }catch(err){
    try{
      const r = await fetch("data.json");
      if (!r.ok) throw err;
      D = await r.json();
      srcNote = "シートに接続できないため同梱データを表示しています";
    }catch(_){
      showMsg("データを読み込めませんでした。<br><small>" + esc(err.message) +
        "</small><br><br><small>file:// で開いていませんか。<br>HTTPサーバ経由で表示してください。</small>");
      $("#sum").textContent = "エラー";
      return;
    }
  }
  boot();
}
start(false);

function boot(){
  byId.clear(); cellMap.clear();
  charChips.length = 0; axisChips.length = 0;
  groups.proj.clear(); groups.gen.clear();
  $("#rProj").innerHTML = '<span class="flab">プロジェクト</span>';
  $("#rGen").innerHTML  = '<span class="flab">期生</span>';
  $("#rChar").innerHTML = '<span class="flab">キャラ</span>';
  $("#rAxes").innerHTML = "";
  const notes = (D.warn || []).concat(srcNote ? [srcNote] : []);
  $("#warn").innerHTML = notes.length
    ? '<span class="flab">注意</span><span class="wtx">' +
      notes.map(esc).join("<br>") + "</span>" : "";
  $("#warn").style.display = notes.length ? "flex" : "none";
  $("#warnDot").hidden = !notes.length;

  D.chars.forEach(c => byId.set(c.id, c));
  D.cells.forEach(c => {
    cellMap.set(c.f + ":" + c.t, c);
    (c.a || []).forEach(a => {
      a._k = a.k || norm(a.l);
      const h = toHira(a._k);
      a._kh = h === a._k ? null : h;   // Only present when Katakana is included
      a._x = [];
      if (a.x) for (const k in a.x) a.x[k].forEach(v => a._x.push((k + ":" + v).replace(/\|/g, "／")));
    });
  });
  // If the previous filter doesn't exist in the current axis, discard it. This prevents a broken state from persisting in the URL.
  const valid = new Set(Object.values(D.axes || {}).map(v => v.axis + ":" + v.label));
  if (valid.size) [...selAxis.keys()].forEach(k => { if (!valid.has(k)) selAxis.delete(k); });

  buildChips();
  buildAxisChips();
  if (!booted){ restore(); booted = true; }
  renderMatrix();
  apply();
  $("#msg").style.display = "none";
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
}

/* ================= Matrix (Draw only once) ================= */
function tokenHTML(a){
  const g = a.g || [], rt = g.includes("retired");
  let h = esc(a.l);
  g.forEach(k => { if (FLAG_MARK[k]) h += '<span class="mk mk-' + k + '">' + FLAG_MARK[k] + "</span>"; });
  // "旧" is not displayed because it would be redundant with the strikethrough.
  const notes = (a.n || []).filter(x => x !== "旧");
  if (notes.length) h += '<span class="nt">(' + esc(notes.join("、")) + ")</span>";
  const ax = [];
  if (a.x) for (const k in a.x) a.x[k].forEach(v => ax.push((k + ":" + v).replace(/\|/g, "／")));
  return '<span class="tk' + (rt ? " rt" : "") + '" data-k="' + esc(a._k) + '"' +
    (a._kh ? ' data-kh="' + esc(a._kh) + '"' : "") +
    (g.length ? ' data-g="' + g.join(" ") + '"' : "") +
    (ax.length ? ' data-x="|' + esc(ax.join("|")) + '|"' : "") + ">" + h + "</span>";
}

function cellHTML(f, t){
  const c = cellMap.get(f + ":" + t);
  if (!c) return "";
  let out = "";
  if (c.s) out += '<i class="st ' + c.s + (c.s === "unsure" ? " u" : "") + '">' +
    esc(c.s === "unsure" ? STATE_LABEL.unsure : (c.r || STATE_LABEL[c.s])) + "</i>";
  if (!c.a) return out;
  let seen = false;
  for (const a of c.a){
    const rt = (a.g || []).includes("retired");
    if (rt && !seen){ out += '<span class="bd">←</span>'; seen = true; }
    out += tokenHTML(a);
  }
  return out;
}

const dispName = c => (useShort && c.abbr) ? c.abbr : c.name;

function renderMatrix(){
  const t0 = performance.now();
  const ch = D.chars;
  let h = '<table id="mx"><thead><tr><th class="cn" style="width:var(--rh)">呼ぶ側 ↓<br>呼ばれる側 →</th>';
  for (const c of ch)
    h += '<th data-c="' + c.id + '" style="width:var(--cw)"><div class="clip">' +
         (c.emoji ? esc(c.emoji) + " " : "") + esc(dispName(c)) + "</div></th>";
  h += "</tr></thead><tbody>";
  for (const r of ch){
    h += '<tr data-r="' + r.id + '"><th><div class="clip">' +
         (r.emoji ? esc(r.emoji) + " " : "") + esc(dispName(r)) + "</div></th>";
    for (const c of ch){
      const cell = cellMap.get(r.id + ":" + c.id);
      h += "<td" + (r.id === c.id ? ' class="dg"' : "") +
           ' data-c="' + c.id + '" data-r="' + r.id + '"' +
           (cell && cell.s ? ' data-s="' + cell.s + '"' : "") +
           '><div class="clip">' + cellHTML(r.id, c.id) + "</div></td>";
    }
    h += "</tr>";
  }
  $("#scroll").innerHTML = h + "</tbody></table>";
  renderMatrix.ms = Math.round(performance.now() - t0);
}

/* ================= Chips ================= */
const groups = {proj:new Map(), gen:new Map()};
function buildChips(){
  D.chars.forEach(c => {
    const p = c.project || "(未設定)";
    if (!groups.proj.has(p)) groups.proj.set(p, []);
    groups.proj.get(p).push(c.id);
    const gs = (c.gens && c.gens.length) ? c.gens : ["(未設定)"];
    gs.forEach(g => {
      if (!groups.gen.has(g)) groups.gen.set(g, []);
      groups.gen.get(g).push(c.id);
    });
  });
  const mk = (row, label, ids, cls) => {
    const b = document.createElement("button");
    b.className = "chip" + (cls ? " " + cls : "");
    b.textContent = label;
    b.onclick = () => {
      const on = ids.filter(i => !hidden.has(i)).length;
      ids.forEach(i => on === ids.length ? hidden.add(i) : hidden.delete(i));
      apply();
    };
    b._ids = ids; row.appendChild(b); charChips.push(b);
  };
  for (const [k, ids] of groups.proj) mk($("#rProj"), k.replace(/^\d+\.\s*/, ""), ids);
  for (const [k, ids] of groups.gen)  mk($("#rGen"),  k.replace(/^\[[^\]]*\]\s*/, ""), ids, "mini");
  D.chars.forEach(c =>
    mk($("#rChar"), (c.emoji ? c.emoji + " " : "") + (c.abbr || c.name), [c.id], "mini"));
}
const charChips = [];

function buildAxisChips(){
  const byAxis = new Map();
  for (const tag in (D.axes || {})) {
    const {axis, label} = D.axes[tag];
    if (!byAxis.has(axis)) byAxis.set(axis, new Set());
    byAxis.get(axis).add(label);
  }
  const wrap = $("#rAxes");
  for (const [axis, labels] of byAxis){
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = '<span class="flab">' + esc(axis) + "</span>";
    [...labels].sort().forEach(v => {
      const key = axis + ":" + v;
      const b = document.createElement("button");
      b.className = "chip mini"; b.textContent = v;
      b.onclick = () => { cycle(selAxis, key); apply(); };
      b._axis = key; row.appendChild(b); axisChips.push(b);
    });
    wrap.appendChild(row);
  }
}
const axisChips = [];

/* ================= Determining which tokens/cells survive =================
   Since CSS alone cannot determine if "no valid tokens remain in a row," this part is handled on the data side.
   Because it doesn't touch the DOM, iterating through 10,000 items only takes a few milliseconds. */
function makeMatcher(q, hira){
  const onlyF = [], notF = [], onlyX = [], notX = [];
  selFlag.forEach((v, k) => (v === "only" ? onlyF : notF).push(k));
  selAxis.forEach((v, k) => (v === "only" ? onlyX : notX).push(k));
  const hasOnly = onlyF.length + onlyX.length > 0;

  const tokenOK = a => {
    const g = a.g || [], x = a._x;
    for (const k of notF) if (g.includes(k)) return false;
    for (const k of notX) if (x.includes(k)) return false;
    if (hasOnly){
      let ok = false;
      for (const k of onlyF) if (g.includes(k)) { ok = true; break; }
      if (!ok) for (const k of onlyX) if (x.includes(k)) { ok = true; break; }
      if (!ok) return false;
    }
    if (!q) return true;
    if (a._k.includes(q)) return true;
    return !!(hira && a._kh && a._kh.includes(q));
  };

  const cellOnly = [], cellNot = [];
  selCell.forEach((v, k) => (v === "only" ? cellOnly : cellNot).push(k));
  // * Cells marked with "※" or those that are invalid do not have a designation, so they are considered empty when filtering by designation.
  const tokenFilterOn = hasOnly || notF.length > 0 || notX.length > 0 || !!q;
  const cellOK = c => {
    const apps = c.a || [];
    // State restriction is applied on a per-cell basis. Even if there are notes, if a designation exists, proceed to the designation-side evaluation.
    if (cellOnly.length && !(c.s && cellOnly.includes(c.s))) return false;
    if (c.s && cellNot.includes(c.s) && !apps.length) return false;
    if (apps.length) return apps.some(tokenOK);
    return !!c.s && !tokenFilterOn;
  };
  return {tokenOK, cellOK, cellOnly, cellNot, onlyF, notF, onlyX, notX};
}

/* Alternately remove rows and columns until a fixed point is reached. Note that removing one may cause the other to become empty. */
function collapse(m, seed){
  const pairs = D.cells.filter(m.cellOK).map(c => [c.f, c.t]);
  let rows = new Set(seed), cols = new Set(seed);
  for (let i = 0; i < 12; i++){
    const nr = new Set(), nc = new Set();
    for (const [f, t] of pairs) if (rows.has(f) && cols.has(t)){ nr.add(f); nc.add(t); }
    if (nr.size === rows.size && nc.size === cols.size) break;
    rows = nr; cols = nc;
  }
  return {rows, cols};
}

/* ================= Applying Filter (Just rewriting a single CSS sheet) ================= */
function apply(){
  const rules = [];

  const raw = $("#q").value.trim();
  // If input in Hiragana, ignore the distinction between different Kana types; if input in Katakana or half-width Katakana, match them as-is.
  const hira = hasHira(raw);
  const q = hira ? normH(raw) : norm(raw);
  const m = makeMatcher(q, hira);
  const seed = D.chars.filter(c => !hidden.has(c.id)).map(c => c.id);
  const keep = autoHide ? collapse(m, seed) : {rows:new Set(seed), cols:new Set(seed)};

  D.chars.forEach(c => {
    if (!keep.rows.has(c.id)) rules.push('tr[data-r="' + c.id + '"]{display:none}');
    if (!keep.cols.has(c.id))
      rules.push('th[data-c="' + c.id + '"],td[data-c="' + c.id + '"]{display:none}');
  });
  const supp = mode === "hide" ? "display:none" : "opacity:.2";

  // Cell state: If there is at least one "Limited," hide the contents of all other cells.
  const cellOnly = [];
  selCell.forEach((v, k) => {
    if (v === "only") cellOnly.push('[data-s="' + k + '"]');
    else rules.push('td[data-s="' + k + '"] .st{' + supp + "}");
  });
  if (cellOnly.length)
    rules.push("td" + cellOnly.map(x => ":not(" + x + ")").join("") + " .clip{" + supp + "}");

  // Designation flags and axes function the same way. Include filters use OR logic, but each exclude filter is applied independently.
  const tokOnly = [];
  selFlag.forEach((v, k) => {
    const sel = '[data-g~="' + k + '"]';
    if (v === "only") tokOnly.push(sel); else rules.push(".tk" + sel + "{" + supp + "}");
  });
  selAxis.forEach((v, k) => {
    const sel = '[data-x*="|' + attr(k) + '|"]';
    if (v === "only") tokOnly.push(sel); else rules.push(".tk" + sel + "{" + supp + "}");
  });
  if (tokOnly.length)
    rules.push(".tk" + tokOnly.map(x => ":not(" + x + ")").join("") + "{" + supp + "}");

  let hits = 0;
  if (q){
    const v = q.replace(/["\\]/g, "\\$&");
    const attrs = hira ? ['[data-k*="' + v + '"]', '[data-kh*="' + v + '"]']
                       : ['[data-k*="' + v + '"]'];
    const sel = attrs.map(a => ".tk" + a).join(",");
    rules.push(sel + "{background:var(--hit);border-radius:3px}");
    rules.push(".tk" + attrs.map(a => ":not(" + a + ")").join("") + "{opacity:.15}");
    hits = document.querySelectorAll(sel).length;
  }
  $("#filter").textContent = rules.join("\n");
  $("#qn").textContent = q ? hits + "件" : "";
  $("#qx").hidden = !q;

  const tbl = $("#mx");
  if (tbl) tbl.style.width = (104 + keep.cols.size * CW[cw]) + "px";
  document.documentElement.style.setProperty("--cw", CW[cw] + "px");
  document.documentElement.style.setProperty("--clamp", clip || 99);
  document.body.classList.toggle("noclip", clip === 0);

  charChips.forEach(b => {
    const on = b._ids.filter(i => !hidden.has(i)).length;
    b.dataset.s = on === 0 ? "off" : on === b._ids.length ? "on" : "part";
  });
  const paint = (b, v) => {
    b.dataset.s = v === "only" ? "on" : "";
    b.classList.toggle("off", v === "not");
  };
  axisChips.forEach(b => paint(b, selAxis.get(b._axis)));
  document.querySelectorAll("[data-cell]").forEach(b => paint(b, selCell.get(b.dataset.cell)));
  document.querySelectorAll("[data-flag]").forEach(b => paint(b, selFlag.get(b.dataset.flag)));
  $("#bAuto").classList.toggle("off", !autoHide);
  $("#bAuto").dataset.s = autoHide ? "on" : "";
  $("#bMode").textContent = mode === "hide" ? "除外を隠す" : "除外を薄く";
  $("#bClip").textContent = clip ? clip + "行で切る" : "行の制限なし";
  $("#bCW").textContent   = "列幅 " + {narrow:"狭", normal:"標準", wide:"広"}[cw];
  const anyAbbr = D.chars.some(c => c.abbr);
  $("#bShort").textContent = "見出し " + (useShort ? "略称" : "フルネーム");
  $("#bShort").hidden = !anyAbbr;

  const only = [], not = [];
  const push = (v, kind, key, label) => (v === "only" ? only : not).push({kind, key, label});
  selCell.forEach((v, k) => push(v, "cell", k, STATE_LABEL[k].replace("※ ", "")));
  selFlag.forEach((v, k) => push(v, "flag", k, FLAG_LABEL[k]));
  selAxis.forEach((v, k) => push(v, "axis", k, k.split(":")[1]));
  const part = (arr, word) => {
    if (!arr.length) return "";
    const shown = arr.slice(0, 3);
    const chips = shown.map(item =>
      '<button class="sum-chip" type="button" data-clear-filter data-kind="' + esc(item.kind) + '" data-key="' + esc(item.key) + '" title="' + esc(word) + 'から外す">' +
      esc(item.label) + '<span class="x">✕</span></button>').join("");
    return '　' + word + ' ' + chips + (arr.length > 3 ? ' <span class="sum-more">…</span>' : '');
  };
  $("#sum").innerHTML = "キャラ <b>" + seed.length + "</b>/" + D.chars.length +
    part(only, "限定") + part(not, "除外") +
    (only.length || not.length ? "" : "　絞り込みなし");
  $("#dim").textContent = keep.rows.size + "×" + keep.cols.size +
    (renderMatrix.ms ? " / " + renderMatrix.ms + "ms" : "");
  const empty = !keep.rows.size || !keep.cols.size;
  $("#msg").style.display = empty ? "grid" : "none";
  if (empty) $("#msg").innerHTML = seed.length
    ? "条件に合う呼称がありません。<br><small>絞り込みを緩めてください。</small>"
    : "表示するキャラクターがありません。";
  save();
}

/* ================= Operations ================= */
$("#strip").onclick = e => {
  if (e.target.closest("[data-clear-filter]")) return;
  const open = !$("#panel").classList.contains("open");
  $("#panel").classList.toggle("open", open);
  $("#strip").classList.toggle("open", open);
  $("#grip").classList.toggle("open", open);
};
$("#sum").onclick = e => {
  const btn = e.target.closest("[data-clear-filter]");
  if (!btn) return;
  e.stopPropagation();
  const kind = btn.dataset.kind;
  const key = btn.dataset.key;
  if (kind === "cell") selCell.delete(key);
  else if (kind === "flag") selFlag.delete(key);
  else if (kind === "axis") selAxis.delete(key);
  apply();
};

/* ---------- Resize panel height by dragging ---------- */
(() => {
  const grip = $("#grip"), panel = $("#panel");
  const setH = px => {
    panelH = Math.max(70, Math.min(px, window.innerHeight * 0.8));
    document.documentElement.style.setProperty("--ph", panelH + "px");
  };
  let on = false;
  grip.addEventListener("pointerdown", e => {
    on = true; grip.setPointerCapture(e.pointerId); e.preventDefault();
  });
  grip.addEventListener("pointermove", e => {
    if (on) setH(e.clientY - panel.getBoundingClientRect().top);
  });
  const end = () => { if (on){ on = false; save(); } };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("dblclick", () => {
    panelH = null;
    document.documentElement.style.removeProperty("--ph");
    save();
  });
  window._setPanelH = setH;
})();
$("#bAll").onclick  = () => { hidden.clear(); apply(); };
$("#bNone").onclick = () => { D.chars.forEach(c => hidden.add(c.id)); apply(); };
$("#bReset").onclick = () => {
  hidden.clear(); selCell.clear(); selFlag.clear(); selAxis.clear();
  $("#q").value = ""; apply();
};
$("#reload").onclick = () => start(true);
$("#bShort").onclick = () => {
  useShort = !useShort;
  if (D) renderMatrix();
  apply();
};
$("#bAuto").onclick = () => { autoHide = !autoHide; apply(); };
$("#bMode").onclick = () => { mode = mode === "hide" ? "dim" : "hide"; apply(); };
$("#bClip").onclick = () => { clip = ({5:3, 3:2, 2:0, 0:5})[clip]; apply(); };
$("#bCW").onclick   = () => { cw = ({narrow:"normal", normal:"wide", wide:"narrow"})[cw]; apply(); };
document.querySelectorAll("[data-cell]").forEach(b =>
  b.onclick = () => { cycle(selCell, b.dataset.cell); apply(); });
document.querySelectorAll("[data-flag]").forEach(b =>
  b.onclick = () => { cycle(selFlag, b.dataset.flag); apply(); });

let qt = null;
$("#q").oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 120); };
$("#qx").onclick = () => { $("#q").value = ""; apply(); };

/* ---------- Details Sheet ---------- */
$("#shX").onclick = () => $("#sheet").classList.remove("open");
$("#scroll").addEventListener("click", e => {
  const td = e.target.closest("td[data-r]");
  if (!td) return;
  document.querySelectorAll("td.sel").forEach(n => n.classList.remove("sel"));
  td.classList.add("sel");
  openSheet(td.dataset.r, td.dataset.c);
});

function openSheet(f, t){
  const from = byId.get(f), to = byId.get(t);
  $("#shA").textContent = (from.emoji ? from.emoji + " " : "") + from.name;
  $("#shB").textContent = f === t ? "自分（一人称）" : (to.emoji ? to.emoji + " " : "") + to.name;
  const c = cellMap.get(f + ":" + t);
  const body = $("#shBody");
  const note = (c && c.s)
    ? (c.s === "unsure"
        ? '<div class="sh-e"><b>未確認</b><br>調べたが見つからなかった呼称です。<br>' +
          "一度も呼んでいないことが確定したわけではありません。</div>"
        : '<div class="sh-e"><b>' + esc(c.r || STATE_LABEL[c.s]) + "</b></div>")
    : "";
  if (!c){
    body.innerHTML = '<div class="sh-e">未調査。<br>この表にまだ記録がありません。</div>';
  } else if (!c.a || !c.a.length){
    body.innerHTML = note;
  } else {
    body.innerHTML = note + c.a.map((a, i) => {
      const g = a.g || [], rt = g.includes("retired");
      const fl = g.map(k => '<span class="flag ' + k + '">' + FLAG_LABEL[k] + "</span>").join("");
      const sub = [];
      const nn = (a.n || []).filter(x => x !== "旧");
      if (nn.length) sub.push(esc(nn.join("・")));
      if (a.src) sub.push("出典: " + esc(a.src.join(" ")));
      return '<div class="tok' + (rt ? " rt" : "") + '"><span class="i">' + (i + 1) + '</span><span>' +
        '<span class="l">' + esc(a.l) + "</span>" +
        (sub.length ? '<div class="sub">' + sub.join(" / ") + "</div>" : "") +
        '</span><span class="f">' + fl + "</span></div>";
    }).join("");
  }
  $("#sheet").classList.add("open");
}

/* ---------- Save and Restore State ---------- */
function save(){
  const s = {h:[...hidden], c:[...selCell], f:[...selFlag], a:[...selAxis],
             m:mode, l:clip, w:cw, u:autoHide, p:panelH, s:useShort};
  location.replace("#" + encodeURIComponent(JSON.stringify(s)));
}
function restore(){
  if (!location.hash) return;
  try{
    const s = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    (s.h || []).forEach(x => hidden.add(x));
    (s.c || []).forEach(([k, v]) => selCell.set(k, v));
    (s.f || []).forEach(([k, v]) => selFlag.set(k, v));
    (s.a || []).forEach(([k, v]) => selAxis.set(k, v));
    if (s.m) mode = s.m;
    if (s.l !== undefined) clip = s.l;
    if (s.w) cw = s.w;
    if (s.u) autoHide = true;
    if (s.s === false) useShort = false;
    if (s.p) window._setPanelH(s.p);
  }catch(e){}
}
