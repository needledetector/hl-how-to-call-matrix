// Dependency-free Chromium smoke test. Synthetic sheets by default; --live uses real data.
// Run: node tests/browser.mjs [path-to-chrome-or-edge] [--live] [--offline] [--url=...]
// Compare real-data performance: --perf [--revision=commit-hash]
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn, execFileSync} from 'node:child_process';
import {readFile, writeFile, mkdtemp, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, extname, sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';

const root = fileURLToPath(new URL('../', import.meta.url));
const live = process.argv.includes('--live');
const perf = process.argv.includes('--perf');
const revision = process.argv.find(arg => arg.startsWith('--revision='))?.slice(11);
if (revision && !/^[a-f0-9]{7,40}$/.test(revision)) throw new Error('Use a commit hash for --revision.');
const pageURL = process.argv.find(arg => arg.startsWith('--url='))?.slice(6);
const candidates = [process.argv.slice(2).find(arg => !arg.startsWith('--')), process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].filter(Boolean);
let executable;
for (const path of candidates) { try { await access(path); executable = path; break; } catch {} }
if (!executable) throw new Error('Pass a Chrome/Edge executable path, or set CHROME_PATH.');
const artifacts = await mkdtemp(join(tmpdir(), 'kosho-ui-'));
const mime = {'.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.png':'image/png', '.webmanifest':'application/manifest+json'};
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const path = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!path.startsWith(resolve(root) + sep)) { res.writeHead(403).end(); return; }
  try {
    const body = revision ? execFileSync('git', ['show', revision + ':' + path.slice(resolve(root).length + 1).replaceAll('\\', '/')], {cwd:root, stdio:['ignore','pipe','ignore'], maxBuffer:5_000_000}) : await readFile(path);
    res.writeHead(200, {'Content-Type':mime[extname(path)] || 'text/plain'}).end(body);
  }
  catch { res.writeHead(404).end(); }
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', `--user-data-dir=${join(artifacts, 'profile')}`, 'about:blank'], {windowsHide:true, stdio:['ignore', 'ignore', 'pipe']});
let socket;
try {
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => reject(new Error('Chrome did not start: ' + stderr.slice(-1200))), 15000);
    browser.once('error', error => { clearTimeout(timeout); reject(error); });
    browser.once('exit', code => { clearTimeout(timeout); reject(new Error('Chrome exited: ' + code + '\n' + stderr.slice(-1200))); });
    browser.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timeout); resolveEndpoint(match[1]); }
    });
  });
  const port = new URL(endpoint).port;
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  await once(socket, 'open');
  let sequence = 0;
  const pending = new Map(), errors = [], failures = [];
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
    if (message.method === 'Network.loadingFailed') failures.push(message.params);
    const callback = pending.get(message.id);
    if (callback) {
      pending.delete(message.id);
      clearTimeout(callback.timeout);
      if (message.error) callback.reject(new Error(JSON.stringify(message.error)));
      else callback.resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timed out: ' + method)); }, 10000);
    pending.set(id, {resolve:resolveCall, reject, timeout});
    socket.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async expression => {
    for (let i = 0; i < 80; i++) {
      if (await evaluate(expression)) return;
      await new Promise(done => setTimeout(done, 100));
    }
    throw new Error('Timed out waiting for ' + expression);
  };
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el.tagName === 'FIELDSET') { [...el.querySelectorAll('input')].find(input => input.value === ${JSON.stringify(value)}).click(); } else { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', {bubbles:true})); } })()`);
  const search = async value => {
    await evaluate(`document.querySelector('#q').value = ${JSON.stringify(value)}; document.querySelector('#q').dispatchEvent(new Event('input'))`);
    await new Promise(done => setTimeout(done, 180));
  };
  const screenshot = async name => {
    const result = await send('Page.captureScreenshot', {format:'png'});
    await writeFile(join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'));
  };
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  if (perf) {
    await send('Emulation.setDeviceMetricsOverride', {width:1280, height:900, deviceScaleFactor:1, mobile:false});
    await send('Page.navigate', {url:origin});
    await waitFor(`document.querySelectorAll('#mx td').length > 0 && document.querySelector('#msg').style.display === 'none'`);
    await new Promise(done => setTimeout(done, 300));
    await send('Emulation.setCPUThrottlingRate', {rate:4});
    await send('Performance.enable');
    await evaluate(`(() => {
      window.geometryReads = 0;
      const rects = Element.prototype.getClientRects;
      Element.prototype.getClientRects = function(...args) { window.geometryReads++; return rects.apply(this, args); };
      for (const name of ['scrollHeight', 'clientHeight']) {
        const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, name);
        Object.defineProperty(Element.prototype, name, {...descriptor, get() { window.geometryReads++; return descriptor.get.call(this); }});
      }
    })()`);
    const baseline = Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const samples = [];
    for (const query of ['ぺこ', '', 'ちゃん', '', 'さん', '']) {
      samples.push(await evaluate(`new Promise(resolve => {
        window.geometryReads = 0;
        const start = performance.now();
        const input = document.querySelector('#q'); input.value = ${JSON.stringify(query)};
        input.dispatchEvent(new Event('input'));
        setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve({query:input.value, elapsedMs:Math.round(performance.now()-start), geometryReads:window.geometryReads}))), 130);
      })`));
    }
    const end = Object.fromEntries((await send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const metrics = Object.fromEntries(['TaskDuration','LayoutDuration','RecalcStyleDuration','ScriptDuration'].map(key => [key + 'Ms', Math.round((end[key]-baseline[key])*1000)]));
    console.log(JSON.stringify({revision:revision || 'workspace',cpuSlowdown:4,cells:await evaluate(`document.querySelectorAll('#mx td').length`),elements:await evaluate(`document.querySelectorAll('#mx *').length`),samples,metrics}, null, 2));
    if (!revision) {
      const cellCount = await evaluate(`document.querySelectorAll('#mx td').length`);
      assert.ok(samples.every(sample => sample.geometryReads < cellCount), 'Clipping checks must stay limited to the viewport');
    }
    assert.deepEqual(errors, []);
  } else if (live) {
    await send('Page.navigate', {url:pageURL || origin});
    try { await waitFor(`document.querySelector('#resultSummary')?.textContent || document.querySelector('#sum')?.textContent === 'エラー'`); } catch (_) {}
    console.log(JSON.stringify(await evaluate(`({url:location.href, message:document.querySelector('#msg')?.textContent, summary:document.querySelector('#sum')?.textContent, result:document.querySelector('#resultSummary')?.textContent, cells:document.querySelectorAll('#mx td').length})`), null, 2));
    console.log(JSON.stringify({errors, failures}, null, 2));
    await screenshot('live');
    console.log('Screenshots: ' + artifacts);
    assert.deepEqual(errors, []);
    assert.ok(await evaluate(`!!document.querySelector('#resultSummary')?.textContent`), 'Live data should render');
    await evaluate(`navigator.serviceWorker.ready.then(() => true)`);
    console.log('Sheet cache after first load:', await evaluate(`caches.keys().then(async keys => (await Promise.all(keys.map(async key => (await (await caches.open(key)).keys()).filter(r => r.url.includes('/gviz/tq')).length))).reduce((a,b) => a+b, 0))`));
    console.log('Dataset snapshot:', await evaluate(`caches.match(new URL('data.snapshot.json', location.href).href).then(hit => !!hit)`));
    if (process.argv.includes('--offline')) {
      await send('Network.emulateNetworkConditions', {offline:true, latency:0, downloadThroughput:0, uploadThroughput:0});
      // Page-level CDP throttling does not cover the worker's separate network target.
      // Reject sheet requests explicitly so the dataset fallback is exercised too.
      await send('Page.addScriptToEvaluateOnNewDocument', {source:`{
        const originalFetch = window.fetch.bind(window);
        window.fetch = (url, ...args) => String(url).startsWith('https://docs.google.com/')
          ? Promise.reject(new TypeError('Network unavailable')) : originalFetch(url, ...args);
      }`});
    }
    await evaluate(`document.documentElement.dataset.beforeReload = '1'`);
    await send('Page.reload');
    await waitFor(`!document.documentElement.dataset.beforeReload && (document.querySelector('#resultSummary')?.textContent || document.querySelector('#sum')?.textContent === 'エラー')`);
    console.log('Controlled reload:', await evaluate(`({result:document.querySelector('#resultSummary')?.textContent,message:document.querySelector('#msg')?.textContent})`));
    assert.ok(await evaluate(`!!document.querySelector('#resultSummary')?.textContent`), 'Reload should render cached data even offline');
    if (process.argv.includes('--offline')) assert.match(await evaluate(`document.querySelector('#warn').textContent`), /前回取得したデータ/);
  } else {
  const names = ['青空あおい', '白雪しろ', '紅葉あかね', '若葉みどり', '星野ひかり', '月見ゆう', '花咲はる', '海野なみ'];
  const csv = rows => rows.map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\n');
  const matrix = [['凡例', ...names], ...names.map((name, i) => [name, ...names.map((other, j) =>
    i === j ? '私◎' : (i === 0 && j === 2) ? '※' : (i === 0 && j === 3) ? '' :
    `${other}ちゃん(愛称)◎、${other}さん*←${other}先輩+`)])];
  const sheets = {'呼称表': csv(matrix), '補助データ': csv([['人物', 'ID', 'グループ', '期生', '略称'],
    ...names.map((name, i) => [name, 'p' + i, i < 4 ? 'グループA' : 'グループB', i % 2 ? '2期生' : '1期生', name.slice(2)])]),
    '軸マッピング': csv([['タグ', '軸', '表示名'], ['愛称', '呼び方', '愛称']])};
  await send('Page.addScriptToEvaluateOnNewDocument', {source:`{
    const sheets = ${JSON.stringify(sheets)};
    const originalFetch = window.fetch.bind(window);
    window.fetch = (url, ...args) => String(url).startsWith('https://docs.google.com/')
      ? Promise.resolve(new Response(sheets[new URL(url).searchParams.get('sheet')], {headers:{'Content-Type':'text/csv'}}))
      : originalFetch(url, ...args);
  }`});
  await send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:true});
  await send('Emulation.setTouchEmulationEnabled', {enabled:true});
  await send('Page.navigate', {url:origin});
  await waitFor(`document.querySelectorAll('.result-card').length === 40`);
  assert.equal(await evaluate(`document.querySelector('#viewList').getAttribute('aria-pressed')`), 'true');
  assert.equal(await evaluate(`document.querySelector('#mx') === null`), true);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate(`(() => { const box = document.querySelector('#searchBox').getBoundingClientRect(); return box.top > innerHeight - 100 && box.bottom <= innerHeight; })()`), true);
  assert.equal(await evaluate(`document.querySelector('.card-detail').textContent`), '詳細…');
  await screenshot('mobile-list');
  await evaluate(`document.querySelector('#q').focus()`);
  await send('Emulation.setDeviceMetricsOverride', {width:390, height:430, deviceScaleFactor:1, mobile:true});
  await waitFor(`document.querySelector('#searchBox').getBoundingClientRect().bottom <= innerHeight`);
  await screenshot('mobile-keyboard-layout');
  await evaluate(`document.querySelector('#q').blur()`);
  await send('Emulation.setDeviceMetricsOverride', {width:390, height:844, deviceScaleFactor:1, mobile:true});
  await click('#nextPage');
  assert.match(await evaluate(`document.querySelector('#pageInfo').textContent`), /^41/);
  await change('#fromPerson', 'p0');
  assert.equal(await evaluate(`document.querySelectorAll('.result-card').length`), 7);
  await change('#toPerson', 'p1');
  assert.equal(await evaluate(`document.querySelectorAll('.result-card').length`), 1);
  assert.match(await evaluate(`document.querySelector('.result-card h3').textContent`), /青空あおい.*白雪しろ/);
  await click('#swapPeople');
  assert.match(await evaluate(`document.querySelector('.result-card h3').textContent`), /白雪しろ.*青空あおい/);
  await click('.card-detail');
  assert.equal(await evaluate(`document.querySelector('#sheet').open`), true);
  await screenshot('mobile-detail');
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  assert.equal(await evaluate(`document.querySelector('#sheet').open`), false);
  await click('#bReset');
  await search('しろ');
  assert.equal(await evaluate(`document.querySelector('#resultSummary').textContent`), '検索結果 21件');
  await click('#nextHit');
  assert.equal(await evaluate(`document.querySelectorAll('.search-current').length`), 1);
  await click('#filterToggle');
  await click('#rFlags .filter-chip:last-child');
  assert.equal(await evaluate(`document.querySelector('#resultSummary').textContent`), '検索結果 7件');
  await click('#rFlags .filter-chip:last-child');
  assert.equal(await evaluate(`document.querySelector('#rFlags .filter-chip:last-child').dataset.state`), 'not');
  await click('#rFlags .filter-chip:last-child');
  assert.equal(await evaluate(`document.querySelector('#resultSummary').textContent`), '検索結果 21件');
  await click('#rFlags .filter-chip:last-child');
  await click('#rFlags .filter-chip:last-child');
  assert.equal(await evaluate(`document.querySelector('#resultSummary').textContent`), '検索結果 14件');
  await screenshot('mobile-filters');
  await change('#fromPerson', 'p0');
  assert.equal(await evaluate(`document.querySelector('#resultSummary').textContent`), '検索結果 2件');
  await click('#filterToggle');
  await evaluate(`document.documentElement.dataset.beforeReload = '1'`);
  await send('Page.reload');
  await waitFor(`!document.documentElement.dataset.beforeReload && document.querySelector('#resultSummary')?.textContent === '検索結果 2件'`);
  assert.equal(await evaluate(`document.querySelector('#fromPerson').value`), 'p0');
  await search('存在しない呼称');
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#msg')).display`), 'grid');
  await click('#msg [data-reset]');
  await click('#viewMatrix');
  await change('#fromPerson', 'p0'); await change('#toPerson', 'p1');
  assert.equal(await evaluate(`document.querySelector('#dim').textContent`), '1行 × 1列');
  await screenshot('mobile-matrix');
  await send('Emulation.setDeviceMetricsOverride', {width:1280, height:900, deviceScaleFactor:1, mobile:false});
  await click('#bReset');
  await screenshot('desktop-matrix');
  await click('#filterToggle');
  await screenshot('desktop-filters');
  await click('#settingsToggle');
  assert.equal(await evaluate(`document.querySelector('#panel').classList.contains('open')`), false);
  await change('#bCW', 'wide');
  assert.equal(await evaluate(`document.documentElement.style.getPropertyValue('--cw')`), '176px');
  const normalWidth = await evaluate(`document.querySelector('#mx').getBoundingClientRect().width`);
  await click('#zoomIn'); await click('#zoomIn');
  assert.equal(await evaluate(`document.querySelector('#zoomValue').textContent`), '120%');
  assert.ok(Math.abs(await evaluate(`document.querySelector('#mx').getBoundingClientRect().width`) / normalWidth - 1.2) < 0.01);
  assert.equal(await evaluate(`JSON.parse(decodeURIComponent(location.hash.slice(1))).z`), 120);
  await screenshot('desktop-zoom');
  await click('#zoomReset');
  assert.equal(await evaluate(`document.querySelector('#zoomValue').textContent`), '100%');
  await change('#bClip', '2');
  await waitFor(`[...document.querySelectorAll('.cell-detail')].some(button => button.textContent === '続きを読む')`);
  await evaluate(`document.querySelector('#scroll').scrollTop = document.querySelector('#scroll').scrollHeight`);
  await waitFor(`[...document.querySelectorAll('#mx tr:last-child .cell-detail')].some(button => button.textContent === '続きを読む')`);
  // Small phone: neither the body nor the fixed control area should overflow the viewport.
  await send('Emulation.setDeviceMetricsOverride', {width:320, height:568, deviceScaleFactor:1, mobile:true});
  await click('#settingsToggle'); await click('#viewList'); await click('#filterToggle');
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate(`document.querySelector('.shell').getBoundingClientRect().bottom <= innerHeight`), true);
  await screenshot('small-phone');
  assert.equal(await evaluate(`(() => {
    const control = document.querySelector('#rFlags .filter-chip').getBoundingClientRect();
    return control.top >= 0 && control.bottom <= innerHeight;
  })()`), true);
  await click('#closeFilters');
  assert.equal(await evaluate(`document.querySelector('#filterToggle').getAttribute('aria-expanded')`), 'false');
  await send('Emulation.setDeviceMetricsOverride', {width:844, height:390, deviceScaleFactor:1, mobile:true});
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  assert.equal(await evaluate(`document.querySelector('.shell').getBoundingClientRect().bottom <= innerHeight`), true);
  await screenshot('phone-landscape');
  assert.equal(await evaluate(`document.querySelector('#pagination').getBoundingClientRect().bottom <= innerHeight`), true);
  assert.deepEqual(errors, []);
  console.log('Browser checks passed: mobile/desktop layouts, direction selection, pagination, search/filter counts, URL restoration, detail dialog, empty state, settings.');
  console.log('Screenshots: ' + artifacts);
  }
} finally {
  socket?.close();
  browser.kill();
  server.closeAllConnections(); server.close();
}
