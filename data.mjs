"use strict";
import {norm} from "./search.mjs";

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
  const warn = (warn0 || []).slice();
  if (!mRows.length || !mRows[0].length)
    throw new Error("呼称表が空です");
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


export {parseCSV, splitOutside, cellState, parseCell, build, loadData};
