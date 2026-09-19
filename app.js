import {loadData} from "./data.mjs";
import {norm, normH, toHira, hasHira, makeMatcher, collapse, matchingCells} from "./search.mjs";

"use strict";
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const CW = {narrow:112, normal:132, wide:176};
const STATE_LABEL = {unsure:"※ 未確認", na:"離籍・未デビュー", omitted:"省略"};
const FLAG_LABEL = {main:"基本", rare:"稀", third:"三人称", egosa:"エゴサワード",
                    retired:"使用終了"};
const FLAG_MARK  = {main:"◎", rare:"*", third:"+", egosa:"☆"};   // Symbols are not supposed to be displayed for retired

let D = null, cellMap = new Map(), byId = new Map();
let booted = false, srcNote = "";
let loading = false;
const hidden  = new Set();     // Hidden character IDs
const selCell = new Map();     // Cell status     → "only" | "not"
const selFlag = new Map();     // Name flag       → "only" | "not"
const selAxis = new Map();     // "Axis:Value"    → "only" | "not"
const cellKey = (from, to) => JSON.stringify([from, to]);
const attr = s => String(s).replace(/["\\]/g, "\\$&");   // For attribute selector strings
let mode = "hide", clip = 5, cw = "normal", autoHide = false, panelH = null, useShort = true;

let fromPerson = "", toPerson = "";
let view = window.matchMedia?.("(max-width: 640px)").matches ? "list" : "matrix";
let results = [], activeMatcher = null, hitIndex = -1, listPage = 0;
let matrixDirty = true;
const PAGE_SIZE = 40;
const filterControls = [];
let clippingFrame = null;

function updateClippingHints(){
  if (view !== "matrix" || !window.requestAnimationFrame) return;
  window.cancelAnimationFrame(clippingFrame);
  clippingFrame = window.requestAnimationFrame(() => {
    // Read sizes together before writing labels to avoid repeated layout work.
    const labels = [...document.querySelectorAll("#mx td .clip")]
      .filter(el => el.getClientRects().length)
      .map(el => [el.nextElementSibling, el.scrollHeight > el.clientHeight + 1]);
    for (const [button, clipped] of labels) {
      if (button.textContent !== "未調査") button.textContent = clipped ? "続きを読む" : "詳細を見る";
    }
  });
}

function renderList(){
  const start = listPage * PAGE_SIZE;
  $("#list").innerHTML = results.slice(start, start + PAGE_SIZE).map(c => {
    const from = byId.get(c.f), to = byId.get(c.t);
    const apps = (c.a || []).filter(activeMatcher.tokenOK);
    const note = c.s && !activeMatcher.cellNot.includes(c.s)
      ? '<span class="list-note">' + esc(c.r || STATE_LABEL[c.s]) + '</span>' : "";
    return '<article class="result-card" data-r="' + esc(c.f) + '" data-c="' + esc(c.t) + '">' +
      '<h3>' + esc(from.name) + '<span class="ar"> → </span>' + esc(to.name) + '</h3>' +
      '<div class="list-tokens">' + apps.map(tokenHTML).join("") + note + '</div>' +
      '<button class="card-detail" aria-label="' + esc(from.name + ' → ' + to.name + ' の詳細') + '">詳細を見る →</button></article>';
  }).join("");
  $("#prevPage").disabled = listPage === 0;
  $("#nextPage").disabled = start + PAGE_SIZE >= results.length;
  $("#pageInfo").textContent = results.length ? (start + 1) + "–" + Math.min(start + PAGE_SIZE, results.length) + " / " + results.length + "組" : "0組";
}

function moveHit(step){
  if (!results.length) return;
  hitIndex = hitIndex < 0 ? (step > 0 ? 0 : results.length - 1)
    : (hitIndex + step + results.length) % results.length;
  const cell = results[hitIndex];
  document.querySelectorAll(".search-current, .axis-current").forEach(el => el.classList.remove("search-current", "axis-current"));
  if (view === "list") {
    listPage = Math.floor(hitIndex / PAGE_SIZE);
    renderList();
  }
  const root = view === "list" ? "#list" : "#scroll";
  const target = $(root + ' [data-r="' + attr(cell.f) + '"][data-c="' + attr(cell.t) + '"]');
  if (target) {
    target.classList.add("search-current");
    target.scrollIntoView({block:"center", inline:"center", behavior:"instant"});
    target.querySelector("button")?.focus({preventScroll:true});
  }
  if (view === "matrix") {
    $('#mx thead th[data-c="' + attr(cell.t) + '"]')?.classList.add("axis-current");
    $('#mx tr[data-r="' + attr(cell.f) + '"] > th')?.classList.add("axis-current");
  }
  $("#qn").textContent = (hitIndex + 1) + " / " + results.length + "セル";
}

/* ================= Loading ================= */
function showMsg(html){ $("#msg").innerHTML = html; $("#msg").style.display = "grid"; }

async function start(bust){
  if (loading) return;
  loading = true;
  $("#reload").disabled = true;
  try {
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
  } finally {
    loading = false;
    $("#reload").disabled = false;
  }
}

function boot(){
  byId.clear(); cellMap.clear();
  charChips.length = 0; filterControls.length = 0;
  groups.proj.clear(); groups.gen.clear();
  $("#rProj").innerHTML = '<span class="flab">プロジェクト</span>';
  $("#rGen").innerHTML  = '<span class="flab">期生</span>';
  $("#rChar").innerHTML = '<span class="flab">キャラ</span>';
  $("#rAxes").innerHTML = "";
  $("#rFlags").innerHTML = '<span class="flab">呼称</span>';
  $("#rCells").innerHTML = '<span class="flab">記録の状態</span>';
  const notes = (D.warn || []).concat(srcNote ? [srcNote] : []);
  $("#warn").innerHTML = notes.length
    ? '<span class="flab">注意</span><span class="wtx">' +
      notes.map(esc).join("<br>") + "</span>" : "";
  $("#warn").style.display = notes.length ? "flex" : "none";
  $("#warnDot").hidden = !notes.length;

  D.chars.forEach(c => byId.set(c.id, c));
  D.cells.forEach(c => {
    cellMap.set(cellKey(c.f, c.t), c);
    (c.a || []).forEach(a => {
      a._k = a.k || norm(a.l);
      const h = toHira(a._k);
      a._kh = h === a._k ? null : h;   // Only present when Katakana is included
      a._x = [];
      if (a.x) for (const k in a.x) a.x[k].forEach(v => a._x.push((k + ":" + v).replace(/\|/g, "／")));
    });
  });

  buildChips();
  buildFilters();
  const options = '<option value="">全員</option>' + D.chars.map(c =>
    '<option value="' + esc(c.id) + '">' + esc((c.emoji ? c.emoji + " " : "") + c.name) + '</option>').join("");
  $("#fromPerson").innerHTML = options;
  $("#toPerson").innerHTML = options;
  if (!booted){ restore(); booted = true; }
  const validAxes = new Set(Object.values(D.axes || {}).map(v => v.axis + ":" + v.label));
  for (const key of selAxis.keys()) if (!validAxes.has(key)) selAxis.delete(key);
  for (const id of hidden) if (!byId.has(id)) hidden.delete(id);
  if (!byId.has(fromPerson)) fromPerson = "";
  if (!byId.has(toPerson)) toPerson = "";
  $("#sheet").close();
  matrixDirty = true;
  apply();
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
  const ax = a._x;
  return '<span class="tk' + (rt ? " rt" : "") + '" data-k="' + esc(a._k) + '"' +
    (a._kh ? ' data-kh="' + esc(a._kh) + '"' : "") +
    (g.length ? ' data-g="' + g.join(" ") + '"' : "") +
    (ax.length ? ' data-x="|' + esc(ax.join("|")) + '|"' : "") + ">" + h + "</span>";
}

function cellHTML(f, t){
  const c = cellMap.get(cellKey(f, t));
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
  const ch = D.chars;
  let h = '<table id="mx"><caption class="sr-only">行が呼ぶ人、列が呼ばれる人です。各セルの詳細ボタンで呼称を確認できます。</caption><thead><tr><th class="cn" style="width:var(--rh)">呼ぶ側 ↓<br>呼ばれる側 →</th>';
  for (const c of ch)
    h += '<th scope="col" data-c="' + esc(c.id) + '" style="width:var(--cw)"><div class="clip">' +
         (c.emoji ? esc(c.emoji) + " " : "") + esc(dispName(c)) + "</div></th>";
  h += "</tr></thead><tbody>";
  for (const r of ch){
    h += '<tr data-r="' + esc(r.id) + '"><th scope="row"><div class="clip">' +
         (r.emoji ? esc(r.emoji) + " " : "") + esc(dispName(r)) + "</div></th>";
    for (const c of ch){
      const cell = cellMap.get(cellKey(r.id, c.id));
      h += "<td" + (r.id === c.id ? ' class="dg"' : "") +
           ' data-c="' + esc(c.id) + '" data-r="' + esc(r.id) + '"' +
           (cell && cell.s ? ' data-s="' + cell.s + '"' : "") +
           '><div class="clip">' + cellHTML(r.id, c.id) + '</div>' +
           '<button class="cell-detail" aria-label="' + esc(r.name + ' → ' + c.name + ' の詳細') + '">' +
           (cell ? '詳細を見る' : '未調査') + '</button></td>';
    }
    h += "</tr>";
  }
  $("#scroll").innerHTML = h + "</tbody></table>";
  matrixDirty = false;
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

function addFilter(row, label, key, selection){
  const wrap = document.createElement("label");
  wrap.className = "filter-field";
  const text = document.createElement("span");
  text.textContent = label;
  const control = document.createElement("select");
  control.innerHTML = '<option value="">指定なし</option><option value="only">限定</option><option value="not">除外</option>';
  control.onchange = () => {
    if (control.value) selection.set(key, control.value); else selection.delete(key);
    apply();
  };
  wrap.appendChild(text); wrap.appendChild(control); row.appendChild(wrap);
  filterControls.push({control, wrap, selection, key});
}

function buildFilters(){
  for (const [key, label] of Object.entries(FLAG_LABEL))
    addFilter($("#rFlags"), label + (FLAG_MARK[key] ? " " + FLAG_MARK[key] : ""), key, selFlag);
  for (const [key, label] of Object.entries(STATE_LABEL)) addFilter($("#rCells"), label, key, selCell);
  const byAxis = new Map();
  for (const {axis, label} of Object.values(D.axes || {})) {
    if (!byAxis.has(axis)) byAxis.set(axis, new Set());
    byAxis.get(axis).add(label);
  }
  for (const [axis, labels] of byAxis){
    const row = document.createElement("div");
    row.className = "frow";
    row.innerHTML = '<span class="flab">' + esc(axis) + "</span>";
    for (const value of [...labels].sort()) addFilter(row, value, axis + ":" + value, selAxis);
    $("#rAxes").appendChild(row);
  }
}

/* ================= Applying Filter (Just rewriting a single CSS sheet) ================= */
function apply(){
  if (!D) return;
  if (view === "matrix" && matrixDirty) renderMatrix();
  const rules = [];

  const raw = $("#q").value.trim();
  // If input in Hiragana, ignore the distinction between different Kana types; if input in Katakana or half-width Katakana, match them as-is.
  const hira = hasHira(raw);
  const q = hira ? normH(raw) : norm(raw);
  const m = makeMatcher(q, hira, {selFlag, selAxis, selCell});
  const seed = D.chars.filter(c => !hidden.has(c.id)).map(c => c.id);
  const rowSeed = seed.filter(id => !fromPerson || id === fromPerson);
  const colSeed = seed.filter(id => !toPerson || id === toPerson);
  const keep = autoHide ? collapse(D.cells, m, rowSeed, colSeed) : {rows:new Set(rowSeed), cols:new Set(colSeed)};
  activeMatcher = m;
  results = matchingCells(D.cells, m, keep.rows, keep.cols);
  hitIndex = -1; listPage = 0;
  document.querySelectorAll(".search-current, .axis-current").forEach(el => el.classList.remove("search-current", "axis-current"));

  D.chars.forEach(c => {
    if (!keep.rows.has(c.id)) rules.push('tr[data-r="' + attr(c.id) + '"]{display:none}');
    if (!keep.cols.has(c.id))
      rules.push('th[data-c="' + attr(c.id) + '"],td[data-c="' + attr(c.id) + '"]{display:none}');
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

  const hits = results.reduce((sum, c) => sum + (c.a || []).filter(m.tokenOK).length, 0);
  if (q){
    const v = attr(q);
    const attrs = hira ? ['[data-k*="' + v + '"]', '[data-kh*="' + v + '"]']
                       : ['[data-k*="' + v + '"]'];
    rules.push(attrs.map(a => ".tk" + a).join(",") + "{background:var(--hit);border-radius:3px}");
    rules.push(".tk" + attrs.map(a => ":not(" + a + ")").join("") + "{display:none}");
    rules.push("td .st, td .bd{display:none}");
  }
  $("#filter").textContent = rules.join("\n");
  $("#qx").hidden = !q;
  $("#searchNav").hidden = !q;
  $("#prevHit").disabled = $("#nextHit").disabled = !results.length;
  $("#qn").textContent = results.length + "セル";
  $("#resultSummary").textContent = q ? "検索結果 " + hits + "件" : hits + "件の呼称・" + results.length + "組";

  const tbl = $("#mx");
  if (tbl) tbl.style.width = (104 + keep.cols.size * CW[cw]) + "px";
  document.documentElement.style.setProperty("--cw", CW[cw] + "px");
  document.documentElement.style.setProperty("--clamp", clip || 99);
  document.body.classList.toggle("noclip", clip === 0);

  charChips.forEach(b => {
    const on = b._ids.filter(i => !hidden.has(i)).length;
    b.dataset.s = on === 0 ? "off" : on === b._ids.length ? "on" : "part";
    b.setAttribute("aria-pressed", on === 0 ? "false" : on === b._ids.length ? "true" : "mixed");
  });
  filterControls.forEach(({control, wrap, selection, key}) => {
    control.value = selection.get(key) || "";
    wrap.dataset.state = control.value;
  });
  $("#bAuto").value = autoHide ? "on" : "off";
  $("#bMode").value = mode;
  $("#bClip").value = String(clip);
  $("#bCW").value = cw;
  $("#bShort").value = useShort ? "short" : "full";
  $("#shortSetting").hidden = !D.chars.some(c => c.abbr);
  $("#fromPerson").value = fromPerson;
  $("#toPerson").value = toPerson;
  $("#rangeCount").textContent = seed.length + "/" + D.chars.length + "人";
  $("#viewMatrix").setAttribute("aria-pressed", String(view === "matrix"));
  $("#viewList").setAttribute("aria-pressed", String(view === "list"));
  $("#scroll").hidden = view !== "matrix";
  $("#list").hidden = view !== "list";
  $("#pagination").hidden = view !== "list" || results.length <= PAGE_SIZE;
  if (view === "list") { renderList(); $("#list").scrollTop = 0; }
  updateClippingHints();

  const only = [], not = [];
  const push = (v, kind, key, label) => (v === "only" ? only : not).push({kind, key, label});
  selCell.forEach((v, k) => push(v, "cell", k, STATE_LABEL[k].replace("※ ", "")));
  selFlag.forEach((v, k) => push(v, "flag", k, FLAG_LABEL[k]));
  selAxis.forEach((v, k) => push(v, "axis", k, k.slice(k.indexOf(":") + 1)));
  const part = (arr, word) => {
    if (!arr.length) return "";
    const shown = arr;
    const chips = shown.map(item =>
      '<button class="sum-chip" type="button" data-clear-filter data-kind="' + esc(item.kind) + '" data-key="' + esc(item.key) + '" title="' + esc(word) + 'から外す">' +
      esc(item.label) + '<span class="x">✕</span></button>').join("");
    return '<span class="condition-group">' + word + ' ' + chips + '</span>';
  };
  const personName = id => id ? byId.get(id)?.name || "全員" : "全員";
  $("#sum").innerHTML = '<span class="people-summary">' + esc(personName(fromPerson)) + ' → ' + esc(personName(toPerson)) + '</span>' +
    (hidden.size ? '<span class="range-summary">人物範囲 ' + seed.length + '/' + D.chars.length + '人</span>' : "") +
    part(only, "限定") + part(not, "除外");
  const filterCount = only.length + not.length + (hidden.size ? 1 : 0);
  $("#filterCount").textContent = filterCount ? "(" + filterCount + ")" : "";
  $("#dim").textContent = view === "matrix" ? keep.rows.size + "行 × " + keep.cols.size + "列" : "";
  const empty = !keep.rows.size || !keep.cols.size || ((!!q || view === "list") && !results.length);
  $("#msg").style.display = empty ? "grid" : "none";
  if (empty) $("#msg").innerHTML = seed.length
    ? '条件に合う記録がありません。<br><small>人物や検索・絞り込み条件を変えてください。</small><button class="tool-button" data-reset>条件をリセット</button>'
    : '表示する人物が選ばれていません。<button class="tool-button" data-reset>全員を表示</button>';
  save();
}

/* ================= Operations ================= */
function togglePanel(kind){
  const filters = kind === "filters" && !$("#panel").classList.contains("open");
  const settings = kind === "settings" && $("#settings").hidden;
  $("#panel").classList.toggle("open", filters);
  $("#grip").classList.toggle("open", filters);
  $("#settings").hidden = !settings;
  $("#filterToggle").setAttribute("aria-expanded", String(filters));
  $("#settingsToggle").setAttribute("aria-expanded", String(settings));
}
$("#filterToggle").onclick = () => togglePanel("filters");
$("#settingsToggle").onclick = () => togglePanel("settings");
$("#closeFilters").onclick = () => { togglePanel(null); $("#filterToggle").focus(); };
$("#closeSettings").onclick = () => { togglePanel(null); $("#settingsToggle").focus(); };
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || $("#sheet").open) return;
  if ($("#panel").classList.contains("open")) $("#closeFilters").click();
  else if (!$("#settings").hidden) $("#closeSettings").click();
});
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
$("#bNone").onclick = () => { if (!D) return; D.chars.forEach(c => hidden.add(c.id)); apply(); };
function resetFilters(){
  hidden.clear(); selCell.clear(); selFlag.clear(); selAxis.clear();
  fromPerson = ""; toPerson = "";
  $("#q").value = ""; apply();
}
$("#bReset").onclick = resetFilters;
$("#msg").onclick = e => { if (e.target.closest("[data-reset]")) resetFilters(); };
$("#reload").onclick = () => start(true);
$("#fromPerson").onchange = e => { fromPerson = e.target.value; hidden.delete(fromPerson); apply(); };
$("#toPerson").onchange = e => { toPerson = e.target.value; hidden.delete(toPerson); apply(); };
$("#swapPeople").onclick = () => { [fromPerson, toPerson] = [toPerson, fromPerson]; apply(); };
$("#viewMatrix").onclick = () => { view = "matrix"; apply(); };
$("#viewList").onclick = () => { view = "list"; apply(); };
$("#bShort").onchange = e => {
  useShort = e.target.value === "short";
  matrixDirty = true;
  apply();
};
$("#bAuto").onchange = e => { autoHide = e.target.value === "on"; apply(); };
$("#bMode").onchange = e => { mode = e.target.value; apply(); };
$("#bClip").onchange = e => { clip = Number(e.target.value); apply(); };
$("#bCW").onchange = e => { cw = e.target.value; apply(); };

let qt = null;
$("#q").oninput = () => { clearTimeout(qt); qt = setTimeout(apply, 120); };
$("#qx").onclick = () => { $("#q").value = ""; apply(); };
$("#q").onkeydown = e => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault(); clearTimeout(qt); apply(); moveHit(1);
  }
};
$("#prevHit").onclick = () => moveHit(-1);
$("#nextHit").onclick = () => moveHit(1);
const changePage = step => {
  listPage = Math.max(0, Math.min(Math.ceil(results.length / PAGE_SIZE) - 1, listPage + step));
  renderList(); $("#list").scrollTop = 0;
};
$("#prevPage").onclick = () => changePage(-1);
$("#nextPage").onclick = () => changePage(1);

/* ---------- Details Sheet ---------- */
$("#shX").onclick = () => $("#sheet").close();
const showDetail = e => {
  const target = e.target.closest("[data-r][data-c]");
  if (!target) return;
  document.querySelectorAll("td.sel").forEach(n => n.classList.remove("sel"));
  target.classList.add("sel");
  openSheet(target.dataset.r, target.dataset.c);
};
$("#scroll").addEventListener("click", showDetail);
$("#list").addEventListener("click", showDetail);

function openSheet(f, t){
  const from = byId.get(f), to = byId.get(t);
  $("#shA").textContent = (from.emoji ? from.emoji + " " : "") + from.name;
  $("#shB").textContent = f === t ? "自分（一人称）" : (to.emoji ? to.emoji + " " : "") + to.name;
  const c = cellMap.get(cellKey(f, t));
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
  $("#sheet").showModal();
  $("#sheet").scrollTop = 0;
}

/* ---------- Save and Restore State ---------- */
function save(){
  const s = {h:[...hidden], c:[...selCell], f:[...selFlag], a:[...selAxis],
             m:mode, l:clip, w:cw, u:autoHide, p:panelH, s:useShort,
             from:fromPerson, to:toPerson, view, q:$("#q").value};
  const hash = "#" + encodeURIComponent(JSON.stringify(s));
  if (location.hash !== hash) history.replaceState(null, "", hash);
}
function restore(){
  if (!location.hash) return;
  try{
    const s = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    if (!s || typeof s !== "object") return;
    if (Array.isArray(s.h)) s.h.forEach(x => { if (typeof x === "string") hidden.add(x); });
    const restoreMap = (entries, target, labels) => {
      if (!Array.isArray(entries)) return;
      for (const entry of entries){
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [k, v] = entry;
        if (typeof k === "string" && (!labels || Object.hasOwn(labels, k)) &&
            (v === "only" || v === "not")) target.set(k, v);
      }
    };
    restoreMap(s.c, selCell, STATE_LABEL);
    restoreMap(s.f, selFlag, FLAG_LABEL);
    restoreMap(s.a, selAxis);
    if (["dim", "hide"].includes(s.m)) mode = s.m;
    if ([0, 2, 3, 5].includes(s.l)) clip = s.l;
    if (Object.hasOwn(CW, s.w)) cw = s.w;
    if (s.u === true) autoHide = true;
    if (s.s === false) useShort = false;
    if (typeof s.from === "string") fromPerson = s.from;
    if (typeof s.to === "string") toPerson = s.to;
    if (["matrix", "list"].includes(s.view)) view = s.view;
    if (typeof s.q === "string") $("#q").value = s.q;
    if (Number.isFinite(s.p) && s.p > 0) window._setPanelH(s.p);
  }catch(e){}
}

// Start after all UI state and event handlers have been initialized.
start(false);
