import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as search from '../search.mjs';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('start(false);', 'globalThis.started = start(false);');

function app(hash = '', loadData = async () => ({chars: [{id: 'a"&', name: 'あお', gens: []}], cells: [], axes: {}}), {mobile = false} = {}) {
  const nodes = new Map();
  const element = () => ({
    value: '', style: {setProperty() {}, removeProperty() {}}, dataset: {},
    classList: {toggle() {}, remove() {}, contains() { return false; }},
    appendChild() {}, addEventListener() {}, setAttribute() {}, close() {},
  });
  const node = selector => {
    if (!nodes.has(selector)) nodes.set(selector, element());
    return nodes.get(selector);
  };
  const location = new URL('https://example.test/matrix/?source=bookmark' + hash);
  const historyWrites = [];
  const context = vm.createContext({...search, loadData, location, navigator: {},
    history: {replaceState(_state, _title, value) { historyWrites.push(value); location.href = new URL(value, location).href; }},
    performance, setTimeout, clearTimeout, window: {innerHeight: 800, matchMedia: () => ({matches: mobile})},
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => [], createElement: element,
      documentElement: element(), body: element()},
  });
  vm.runInContext(source, context);
  return {context, node, location, historyWrites};
}

test('initialization renders escaped IDs and ignores invalid or stale URL filters', async () => {
  const hash = '#' + encodeURIComponent(JSON.stringify({c: [['unknown', 'only']], a: [['gone:value', 'only']], w: 'bad', l: 77}));
  const {context, node, location} = app(hash);
  await context.started;
  assert.match(node('#scroll').innerHTML, /data-c="a&quot;&amp;"/);
  assert.equal(location.hash, '');
  assert.equal(vm.runInContext('cw', context), 'normal');
  assert.equal(vm.runInContext('clip', context), 5);
  assert.equal(vm.runInContext('autoHide', context), true);
  assert.equal(vm.runInContext('useShort', context), false);
  assert.equal(node('#reload').disabled, false);
});

test('restoring all characters hidden preserves the empty-state message', async () => {
  const {context, node} = app('#' + encodeURIComponent(JSON.stringify({h: ['a"&']})));
  await context.started;
  assert.equal(node('#msg').style.display, 'grid');
  assert.match(node('#msg').innerHTML, /表示する人物が選ばれていません/);
});

test('controls work before data loads and repeated reloads share the active load', async () => {
  let resolve, calls = 0;
  const {context, node} = app('', () => {
    calls++;
    return new Promise(done => resolve = done);
  });
  assert.doesNotThrow(() => node('#bNone').onclick());
  assert.doesNotThrow(() => node('#bReset').onclick());
  await node('#reload').onclick();
  assert.equal(calls, 1);
  resolve({chars: [], cells: [], axes: {}});
  await context.started;
  assert.equal(node('#reload').disabled, false);
});

test('explicit saved display settings override the new defaults', async () => {
  const {context, location} = app('#' + encodeURIComponent(JSON.stringify({u:false, s:true})));
  await context.started;
  const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  assert.equal(saved.u, false);
  assert.equal(saved.s, true);
});

test('display-only changes reuse matching results and a changed filter recalculates them', async () => {
  const {context, node} = app();
  await context.started;
  const initial = vm.runInContext('matchCache', context);
  node('#bCW').onchange({target:{value:'wide'}});
  assert.equal(vm.runInContext('matchCache', context), initial);
  node('#bShort').onchange({target:{value:'short'}});
  assert.equal(vm.runInContext('matchCache', context), initial);
  node('#bNone').onclick();
  assert.notEqual(vm.runInContext('matchCache', context), initial);
});

test('table scale restores from URL and can be reset without clearing filters', async () => {
  const {context, node, location} = app('#' + encodeURIComponent(JSON.stringify({z:140, c:[['unsure', 'only']]})));
  await context.started;
  assert.equal(node('#zoomValue').textContent, '140%');
  node('#zoomReset').onclick();
  assert.equal(node('#zoomValue').textContent, '100%');
  const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  assert.equal(Object.hasOwn(saved, 'z'), false);
  assert.deepEqual(saved.c, [['unsure', 'only']]);
});

test('desktop and mobile defaults leave the URL untouched; restoring defaults removes the hash', async () => {
  for (const mobile of [false, true]) {
    const {context, node, location, historyWrites} = app('', undefined, {mobile});
    await context.started;
    assert.equal(location.hash, '');
    assert.deepEqual(historyWrites, []);
    assert.equal(vm.runInContext('view', context), mobile ? 'list' : 'matrix');
    node('#zoomIn').onclick();
    assert.deepEqual(JSON.parse(decodeURIComponent(location.hash.slice(1))), {z:110});
    node('#zoomReset').onclick();
    assert.equal(location.href, 'https://example.test/matrix/?source=bookmark');
    node(mobile ? '#viewMatrix' : '#viewList').onclick();
    const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    assert.deepEqual(saved, {view:mobile ? 'matrix' : 'list'});
    const restored = app(location.hash, undefined, {mobile});
    await restored.context.started;
    assert.equal(vm.runInContext('view', restored.context), saved.view);
    node(mobile ? '#viewList' : '#viewMatrix').onclick();
    assert.equal(location.hash, '');
  }
});

test('legacy full URLs restore explicit settings and omit default values on save', async () => {
  const legacy = {h:[], c:[], f:[], a:[], m:'hide', l:5, w:'normal', u:false, p:null,
    s:true, from:'', to:'', view:'matrix', q:'しろ', z:100};
  const {context, node, location} = app('#' + encodeURIComponent(JSON.stringify(legacy)));
  await context.started;
  assert.equal(node('#q').value, 'しろ');
  assert.deepEqual(JSON.parse(decodeURIComponent(location.hash.slice(1))), {u:false, s:true, q:'しろ'});
  node('#bAuto').onchange({target:{value:'on'}});
  node('#bShort').onchange({target:{value:'full'}});
  assert.deepEqual(JSON.parse(decodeURIComponent(location.hash.slice(1))), {q:'しろ'});
  node('#bReset').onclick();
  assert.equal(location.hash, '');
});

test('table scale ignores invalid saved values and stops at the supported limits', async () => {
  const {context, node} = app('#' + encodeURIComponent(JSON.stringify({z:999})));
  await context.started;
  assert.equal(node('#zoomValue').textContent, '100%');
  for (let i = 0; i < 10; i++) node('#zoomIn').onclick();
  assert.equal(node('#zoomValue').textContent, '160%');
  assert.equal(node('#zoomIn').disabled, true);
  for (let i = 0; i < 15; i++) node('#zoomOut').onclick();
  assert.equal(node('#zoomValue').textContent, '60%');
  assert.equal(node('#zoomOut').disabled, true);
});
