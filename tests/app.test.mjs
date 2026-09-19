import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as search from '../search.mjs';

const source = (await readFile(new URL('../app.js', import.meta.url), 'utf8'))
  .replace(/^import .*;\r?\n/gm, '')
  .replace('start(false);', 'globalThis.started = start(false);');

function app(hash = '', loadData = async () => ({chars: [{id: 'a"&', name: 'あお', gens: []}], cells: [], axes: {}})) {
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
  const location = {hash, replace(value) { this.hash = value; }};
  const context = vm.createContext({...search, loadData, location, navigator: {},
    history: {replaceState(_state, _title, value) { location.hash = value; }},
    performance, setTimeout, clearTimeout, window: {innerHeight: 800},
    document: {addEventListener() {}, querySelector: node, querySelectorAll: () => [], createElement: element,
      documentElement: element(), body: element()},
  });
  vm.runInContext(source, context);
  return {context, node, location};
}

test('initialization renders escaped IDs and ignores invalid or stale URL filters', async () => {
  const hash = '#' + encodeURIComponent(JSON.stringify({c: [['unknown', 'only']], a: [['gone:value', 'only']], w: 'bad', l: 77}));
  const {context, node, location} = app(hash);
  await context.started;
  assert.match(node('#scroll').innerHTML, /data-c="a&quot;&amp;"/);
  const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  assert.deepEqual(saved.c, []);
  assert.deepEqual(saved.a, []);
  assert.equal(saved.w, 'normal');
  assert.equal(saved.l, 5);
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

test('table scale restores from URL and can be reset without clearing filters', async () => {
  const {context, node, location} = app('#' + encodeURIComponent(JSON.stringify({z:140, c:[['unsure', 'only']]})));
  await context.started;
  assert.equal(node('#zoomValue').textContent, '140%');
  node('#zoomReset').onclick();
  assert.equal(node('#zoomValue').textContent, '100%');
  const saved = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  assert.equal(saved.z, 100);
  assert.deepEqual(saved.c, [['unsure', 'only']]);
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
