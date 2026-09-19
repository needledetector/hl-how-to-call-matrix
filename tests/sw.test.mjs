import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
function worker() {
  const entries = new Map(), handlers = {}, deleted = [];
  const key = value => typeof value === 'string' ? value : value.url;
  const cache = {
    put: async (k, r) => entries.set(key(k), r),
    match: async k => entries.get(key(k))?.clone(),
    addAll: async () => {},
  };
  const context = vm.createContext({URL, caches: {
    open: async () => cache,
    keys: async () => ['kosho-v6', 'kosho-v7', 'kosho-data-v1', 'another-app'],
    delete: async k => deleted.push(k),
  }, self: {location: {origin: 'https://example.test'}, addEventListener: (name, fn) => handlers[name] = fn, clients: {claim() {}}, skipWaiting() {}}, fetch: async () => new Response('fresh')});
  vm.runInContext(source, context);
  return {context, handlers, deleted, cache};
}
const request = (sheet, timestamp) => new Request(`https://docs.google.com/spreadsheets/d/id/gviz/tq?tqx=out:csv&sheet=${sheet}&_=${timestamp}`);

test('offline cache distinguishes sheets and ignores only reload timestamps', async () => {
  const {context} = worker();
  context.fetch = async r => new Response(new URL(r.url).searchParams.get('sheet'));
  await context.sheetResponse(request('matrix', 1));
  await context.sheetResponse(request('aux', 1));
  context.fetch = async () => { throw new Error('offline'); };
  assert.equal(await (await context.sheetResponse(request('aux', 2))).text(), 'aux');
  assert.equal(await (await context.sheetResponse(request('matrix', 3))).text(), 'matrix');
  await assert.rejects(context.sheetResponse(request('axis', 2)), /offline/);
});

test('HTTP errors use cached data without replacing it', async () => {
  const {context} = worker();
  await context.sheetResponse(request('matrix', 1));
  context.fetch = async () => new Response('unavailable', {status: 503});
  assert.equal(await (await context.sheetResponse(request('matrix', 2))).text(), 'fresh');
  assert.equal((await context.sheetResponse(request('aux', 2))).status, 503);
});

test('activation deletes only old app caches', async () => {
  const {handlers, deleted} = worker();
  let pending;
  handlers.activate({waitUntil: promise => pending = promise});
  await pending;
  assert.deepEqual(deleted, ['kosho-v6']);
});

test('failed asset installation does not activate a partial release', async () => {
  const {handlers, cache, context} = worker();
  let activated = false, pending;
  cache.addAll = async () => { throw new Error('missing module'); };
  context.self.skipWaiting = () => { activated = true; };
  handlers.install({waitUntil: promise => pending = promise});
  await assert.rejects(pending, /missing module/);
  assert.equal(activated, false);
});
