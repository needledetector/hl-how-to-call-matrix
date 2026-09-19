"use strict";

// Use NFKC to convert half-width kana to full-width kana and normalize differences in width and size. The distinction between hiragana and katakana is preserved.
const norm  = s => s.normalize("NFKC").toLowerCase().replace(/[\s　]/g, "");
// Convert Katakana to Hiragana. This is because names are essentially phonetic transcriptions and often have spelling variations.
const toHira = s => s.replace(/[\u30a1-\u30f6\u30fd\u30fe]/g,
                              c => String.fromCharCode(c.charCodeAt(0) - 0x60));
const normH = s => toHira(norm(s));
const hasHira = s => /[\u3041-\u3096]/.test(s);

function makeMatcher(q, hira, {selFlag, selAxis, selCell}){
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

// Rows and columns are independent: each matching pair keeps both endpoints.
function collapse(cells, m, rowSeed, colSeed = rowSeed){
  const allowedRows = new Set(rowSeed), allowedCols = new Set(colSeed);
  const rows = new Set(), cols = new Set();
  for (const c of cells) {
    if (allowedRows.has(c.f) && allowedCols.has(c.t) && m.cellOK(c)) {
      rows.add(c.f); cols.add(c.t);
    }
  }
  return {rows, cols};
}

function matchingCells(cells, matcher, rows, cols){
  return cells.filter(c => rows.has(c.f) && cols.has(c.t) && matcher.cellOK(c));
}

export {norm, normH, toHira, hasHira, makeMatcher, collapse, matchingCells};
