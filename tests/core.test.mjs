import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV, parseCell, cellState, build, loadData} from '../data.mjs';
import {norm, normH, toHira, makeMatcher, collapse, matchingCells} from '../search.mjs';

const matrix = [['凡例', 'あお', 'しろ'], ['あお', '私◎', 'シロ(愛称)*←白さん'], ['しろ', '※', '']];
const selections = (overrides = {}) => ({selFlag: new Map(), selAxis: new Map(), selCell: new Map(), ...overrides});
const token = (label, g = [], x = []) => ({_k: norm(label), _kh: toHira(norm(label)), _x: x, g});

test('CSV preserves quoted commas, newlines and escaped quotes', () => {
  assert.deepEqual(parseCSV('名前,呼称\r\n"あ,お","一\n""二"""\r\n,,\r\n'), [['名前', '呼称'], ['あ,お', '一\n"二"']]);
});

test('appellations preserve notes, flags, order and retired names', () => {
  const result = parseCell('シロ(愛称、1:23)◎*、白ちゃん(旧)←白さん+');
  assert.deepEqual(result.map(a => a.label), ['シロ', '白ちゃん', '白さん']);
  assert.deepEqual(result[0].flags, ['main', 'rare']);
  assert.deepEqual(result[0].times, ['1:23']);
  assert.deepEqual(result[1].flags, ['retired']);
  assert.deepEqual(result[2].flags, ['third', 'retired']);
  assert.deepEqual(cellState('(デビュー時離籍済)先輩+'), {state: 'na', reason: 'デビュー時離籍済', rest: '先輩+'});
});

test('build combines IDs, metadata and mapped axes', () => {
  const data = build(matrix, [['人物', 'ID', '略称'], ['あお', 'blue', '青']], [['タグ', '軸', '表示名'], ['愛称', '種類', 'ニックネーム']], []);
  assert.equal(data.chars[0].id, 'blue');
  assert.equal(data.chars[0].abbr, '青');
  assert.deepEqual(data.cells[1].a[0].x, {種類: ['ニックネーム']});
  assert.equal(data.cells[2].s, 'unsure');
  assert.deepEqual(data.warn, []);
});

test('malformed optional sheets produce warnings instead of throwing', () => {
  const warnings = ['既存の警告'];
  const data = build(matrix, [['不明'], ['値']], [['a', 'b', 'c', 'd', 'e']], warnings);
  assert.equal(data.chars.length, 2);
  assert.equal(data.warn.length, 3);
  assert.deepEqual(warnings, ['既存の警告']);
  assert.throws(() => build([], [], []), /呼称表が空/);
});

test('missing optional sheets do not prevent matrix loading', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (new URL(url).searchParams.get('sheet') !== '呼称表') throw new Error('offline');
    return new Response('凡例,あお\nあお,私◎');
  });
  const data = await loadData(false);
  assert.equal(data.cells[0].a[0].l, '私');
  assert.ok(data.warn.includes('軸マッピングが空です'));
});

test('hiragana search matches katakana while katakana search remains distinct', () => {
  assert.equal(norm(' ｼﾛ Ａ '), 'シロa');
  assert.equal(makeMatcher(normH('しろ'), true, selections()).tokenOK(token('シロ')), true);
  assert.equal(makeMatcher(norm('シロ'), false, selections()).tokenOK(token('しろ')), false);
});

test('include filters use OR and exclusions take precedence', () => {
  const m = makeMatcher('', false, selections({selFlag: new Map([['main', 'only'], ['retired', 'not']]), selAxis: new Map([['種類:愛称', 'only']])}));
  assert.equal(m.tokenOK(token('私', ['main'])), true);
  assert.equal(m.tokenOK(token('私', [], ['種類:愛称'])), true);
  assert.equal(m.tokenOK(token('私', ['main', 'retired'])), false);
  assert.equal(m.tokenOK(token('私')), false);
});

test('cell notes and tokens retain independent filtering semantics', () => {
  const m = makeMatcher('', false, selections({selCell: new Map([['na', 'not']])}));
  assert.equal(m.cellOK({s: 'na'}), false);
  assert.equal(m.cellOK({s: 'na', a: [token('先輩')]}), true);
  assert.equal(makeMatcher('先', false, selections()).cellOK({s: 'unsure'}), false);
});

test('auto-hide keeps independent caller and recipient axes within selected characters', () => {
  const cells = [{f: 'a', t: 'b', a: [token('私')]}, {f: 'b', t: 'c', s: 'unsure'}];
  const result = collapse(cells, makeMatcher('', false, selections()), ['a', 'b']);
  assert.deepEqual([...result.rows], ['a']);
  assert.deepEqual([...result.cols], ['b']);
});

test('directional selection does not require callers to also be selected as recipients', () => {
  const cells = [{f: 'a', t: 'b', a: [token('しろ')]}, {f: 'b', t: 'a', a: [token('あお')]}];
  const matcher = makeMatcher('', false, selections());
  const keep = collapse(cells, matcher, ['a'], ['b']);
  assert.deepEqual([...keep.rows], ['a']);
  assert.deepEqual([...keep.cols], ['b']);
  assert.deepEqual(matchingCells(cells, matcher, keep.rows, keep.cols), [cells[0]]);
});

test('search results omit hidden people and calls rejected by active filters', () => {
  const cells = [
    {f: 'a', t: 'b', a: [token('シロ', ['main']), token('シロ先輩', ['retired'])]},
    {f: 'c', t: 'b', a: [token('シロ')]},
    {f: 'a', t: 'c', s: 'na', a: [token('シロ', ['retired'])]},
  ];
  const matcher = makeMatcher('しろ', true, selections({selFlag: new Map([['retired', 'not']])}));
  const results = matchingCells(cells, matcher, new Set(['a']), new Set(['b', 'c']));
  assert.equal(results.length, 1);
  assert.equal(results.reduce((count, cell) => count + cell.a.filter(matcher.tokenOK).length, 0), 1);
});
