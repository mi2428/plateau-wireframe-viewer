import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Serve only dist/, never test fixtures or /data. One ephemeral port, owned and closed here.
const types = { html: 'text/html', js: 'text/javascript', css: 'text/css', wasm: 'application/wasm', json: 'application/json', txt: 'text/plain' };
const requests = [];
const server = createServer(async (request, response) => {
  requests.push({ path: request.url, method: request.method });
  const path = new URL(request.url, 'http://localhost').pathname;
  const mount = path.startsWith('/viewer/') ? '/viewer/' : path === '/viewer' ? null : '/';
  const name = mount ? decodeURIComponent(path.slice(mount.length)) || 'index.html' : null;
  if (!name || name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '..' || part === '.') || request.method !== 'GET') {
    response.writeHead(404).end(); return;
  }
  try {
    const data = await readFile(resolve('dist', name));
    response.writeHead(200, { 'Content-Type': types[name.split('.').at(-1)] || 'application/octet-stream' });
    response.end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const external = [], errors = [];
try {
for (const prefix of ['/', '/viewer/']) {
const base = `http://127.0.0.1:${server.address().port}${prefix}`;
const requestStart = requests.length;
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (!['data:', 'blob:'].includes(url.protocol) && (url.origin !== new URL(base).origin || !url.pathname.startsWith(prefix) || /\/(data|samples)\//.test(url.pathname))) {
    external.push(url.href); return route.abort();
  }
  return route.continue();
});
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
const status = () => page.locator('#status').textContent();
async function cornerMargins(width, height) {
  const rect = await page.evaluate(() => Object.fromEntries(['.files', '.lod', '.views', '.legend', '.hud', '.footer small', '.footer a'].map(selector =>
    [selector, document.querySelector(selector).getBoundingClientRect().toJSON()])));
  assert.equal(rect['.files'].left, 12);
  assert.equal(rect['.files'].top, 12);
  assert.equal(rect['.lod'].right, width - 12);
  if (width > 700) assert.equal(rect['.lod'].top, 12);
  assert.equal(rect['.views'].left, 12);
  assert.equal(rect['.legend'].right, width - 12);
  assert.equal(rect['.views'].bottom, height - 12);
  assert.equal(rect['.legend'].bottom, height - 12);
  const intersects = (a, b) => a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5;
  for (const element of ['.footer small', '.footer a']) for (const control of ['.files', '.lod', '.views', '.legend', '.hud']) {
    assert.ok(!intersects(rect[element], rect[control]), `${width}x${height}: ${element} overlaps ${control}`);
  }
}
async function unifiedTextColors() {
  const colors = await page.evaluate(() => Object.fromEntries(['#status', '.legend h2', '.legend li', '.footer small', '.footer a'].map(selector =>
    [selector, getComputedStyle(document.querySelector(selector)).color])));
  assert.equal(new Set(Object.values(colors)).size, 1, `UI text colors differ: ${JSON.stringify(colors)}`);
  assert.equal(await page.locator('.footer a').evaluate(element => getComputedStyle(element).textDecorationLine), 'underline');
}
async function pixels() {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => {
    const gl = document.querySelector('canvas').getContext('webgl2');
    const pixels = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++;
    resolve(count);
  })));
}
async function visible(name) {
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Viewing:'), null, { timeout: 60000 });
  for (let i = 0; i < 80; i++) {
    if (await pixels() > 20) { console.log(`${name}: rendered`); return; }
    await page.waitForTimeout(100);
  }
  assert.fail(`${name}: no visible WebGL pixels; ${await status()}`);
}
async function open(path, folder) {
  await page.locator('#mainFile').setInputFiles(path);
  if (folder) {
    await page.locator('#folderBtn').waitFor({ state: 'visible', timeout: 30000 });
    assert.match(await status(), /Missing selected file/);
    await page.locator('#folderFile').setInputFiles(folder);
  }
  await visible(path);
}

try {
  const response = await page.goto(`${base}?source=/data/secret.gml`);
  assert.equal(response.headers()['content-security-policy'], undefined, 'static hosting needs no custom response headers');
  assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /connect-src 'self'/);
  assert.equal(await page.locator('html').getAttribute('lang'), 'en');
  assert.match(await status(), /Choose a local/);
  await cornerMargins(1360, 900);
  await unifiedTextColors();
  const footer = page.locator('.footer'), notices = footer.locator('a');
  assert.equal(await page.locator('.legend a, .legend small').count(), 0, 'legend contains only surface colors');
  assert.equal(new URL(await notices.getAttribute('href'), base).href, new URL('NOTICE.txt', base).href);
  const noticeText = await (await page.request.get(new URL('NOTICE.txt', base).href)).text();
  assert.match(noticeText, /Third-party software:/);
  assert.doesNotMatch(noticeText, /[\u3040-\u30ff\u3400-\u9fff]|unofficial viewer|actual PLATEAU data/i);
  const footerLayout = await footer.evaluate(element => {
    const note = element.querySelector('small').getBoundingClientRect(), link = element.querySelector('a').getBoundingClientRect();
    return { height: element.getBoundingClientRect().height, center: (note.left + link.right) / 2, linkRight: link.right };
  });
  assert.ok(footerLayout.height <= 20 && Math.abs(footerLayout.center - 680) < 3, 'notices are one centered line on desktop');
  assert.equal(await pixels(), 0, 'initial viewer is empty, no sample auto-load');
  assert.equal(await page.locator('#plateauBtn').textContent(), '');
  assert.equal(await page.locator('#themeBtn').textContent(), '');
  const top = await page.evaluate(() => Object.fromEntries(['.files', '.hud', '.lod'].map(selector => [selector, document.querySelector(selector).getBoundingClientRect().toJSON()])));
  assert.ok(top['.files'].right < top['.hud'].left && top['.hud'].right < top['.lod'].left, 'desktop status clears left toolbar and top-right LOD');
  for (const [width, height] of [[1121, 900], [1120, 900], [1000, 900], [701, 600], [700, 600], [520, 390]]) {
    await page.setViewportSize({ width, height });
    await cornerMargins(width, height);
  }
  await page.setViewportSize({ width: 1360, height: 900 });
  assert.equal(requests.slice(requestStart).some(({ path }) => /\/(samples|data)\//.test(new URL(path, base).pathname)), false);
  assert.equal(await page.locator('[popover], #clipAxis, #source, #sectionPanel').count(), 0);
  assert.deepEqual(await page.locator('#canvas').boundingBox(), { x: 0, y: 0, width: 1360, height: 900 });
  assert.equal(await page.locator('#canvas').getAttribute('tabindex'), null, 'full-screen canvas does not draw a viewport-sized focus outline');
  assert.equal(await page.locator('#pointSize').count(), 0, 'point size control and its behavior are removed');
  assert.equal(await page.locator('#birdBtn').isDisabled(), true, 'bird orbit is unavailable without a model');
  const birdIcon = await page.evaluate(() => {
    const bird = document.querySelector('#birdBtn'), iso = document.querySelector('#isoBtn');
    return { opacity: getComputedStyle(bird).opacity, color: getComputedStyle(bird).color,
      isoColor: getComputedStyle(iso).color, width: bird.querySelector('svg').getBoundingClientRect().width,
      isoWidth: iso.querySelector('svg').getBoundingClientRect().width };
  });
  assert.equal(birdIcon.opacity, '1');
  assert.equal(birdIcon.color, birdIcon.isoColor);
  assert.equal(birdIcon.width, birdIcon.isoWidth);
  assert.equal(await page.locator('.files #themeBtn').count(), 1, 'theme toggle joins the top-left toolbar');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'openBtn', 'keyboard focus starts at a usable control, not the entire canvas');
  await page.locator('#canvas').click({ position: { x: 400, y: 300 } });
  assert.equal(await page.locator('#canvas').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  for (const button of await page.locator('.icon-button').all()) {
    assert.ok(await button.getAttribute('title'));
    assert.ok(await button.getAttribute('aria-label'));
  }
  await page.evaluate(() => {
    const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
    globalThis.ownedFileUrls = new Set();
    globalThis.revokedFileUrls = new Set();
    URL.createObjectURL = function (file) {
      const url = create.call(this, file);
      if (file instanceof File) globalThis.ownedFileUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = function (url) {
      if (globalThis.ownedFileUrls.has(url)) globalThis.revokedFileUrls.add(url);
      return revoke.call(this, url);
    };
  });

  await open('test/fixtures/gml/sample.gml');
  assert.equal(await page.locator('#birdBtn').isEnabled(), true);
  await page.locator('#birdBtn').click();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'true');
  const flightStart = await page.locator('#canvas').screenshot();
  await page.waitForTimeout(700);
  assert.notDeepEqual(await page.locator('#canvas').screenshot(), flightStart, 'bird mode visibly orbits the model');
  await page.locator('#birdBtn').click();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'false');
  await page.locator('#birdBtn').click();
  await page.locator('#fitBtn').click();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'false', 'manual view controls end bird mode');
  await page.locator('#birdBtn').click();
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(420, 310);
  await page.mouse.up();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'false', 'dragging ends bird mode');
  assert.equal(await page.locator('#themeBtn').getAttribute('title'), 'Switch to light theme');
  await page.locator('#themeBtn').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  await unifiedTextColors();
  assert.equal(await page.locator('#themeBtn .sun').evaluate(element => getComputedStyle(element).display), 'inline');
  assert.equal(await page.locator('#themeBtn').getAttribute('title'), 'Switch to dark theme');
  assert.equal(await page.locator('#themeBtn').getAttribute('aria-label'), 'Switch to dark theme');
  assert.equal(await page.locator('#legend li').count(), 14);
  assert.ok(await pixels() > 20);
  await page.locator('#themeBtn').click();
  await unifiedTextColors();
  await page.locator('#isoBtn').click();
  await page.locator('#topBtn').click();
  await page.locator('#projectionBtn').click();
  await page.locator('#birdBtn').click();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'true', 'bird mode works with orthographic projection');
  await page.locator('#birdBtn').click();
  await page.locator('#fitBtn').click();
  assert.equal(await page.locator('#projectionBtn').getAttribute('aria-pressed'), 'true');
  assert.ok(await pixels() > 20);

  await open('test/fixtures/gml/profile.gml', 'test/fixtures/gml');
  assert.match(await page.locator('#details').textContent(), /original rings/);
  await page.locator('[name=lod][value=all]').check();
  await visible('GML All LOD');
  assert.match(await page.locator('#details').textContent(), /LOD all/);
  await page.locator('[name=lod][value="4"]').check();
  await page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true');
  assert.match(await status(), /LOD/);
  await page.locator('[name=lod][value=highest]').check();
  await visible('GML Auto LOD');

  for (const name of ['tileset', 'draco', 'meshopt', 'pnts', 'implicit', 'external-i3dm', 'multiple', 'skin-instances', 'embedded']) {
    await open(`test/fixtures/tiles/${name === 'tileset' ? 'tileset.json' : `${name}-tileset.json`}`, 'test/fixtures/tiles');
  }
  assert.ok(await page.evaluate(() => ownedFileUrls.size > 0 && ownedFileUrls.size === revokedFileUrls.size), 'selected File ObjectURLs are revoked on model change');
  await open('test/fixtures/point-cloud/dependency.gml', 'test/fixtures/point-cloud');
  assert.match(await page.locator('#details').textContent(), /points 6/);
  assert.ok(requests.some(({ path }) => path.endsWith('/decoders/laz/voxelkloud_wasm_codecs_bg.wasm')));
  await page.evaluate(() => {
    const terminate = Worker.prototype.terminate;
    globalThis.codecTerminations = 0;
    Worker.prototype.terminate = function () { globalThis.codecTerminations++; return terminate.call(this); };
  });
  let releaseCodec;
  const held = new Promise(resolve => { releaseCodec = resolve; });
  await context.route('**/decoders/laz/voxelkloud_wasm_codecs_bg.wasm', route => releaseCodec(route));
  const codecRequest = context.waitForEvent('request', { predicate: request => request.url().endsWith('/decoders/laz/voxelkloud_wasm_codecs_bg.wasm') });
  await page.locator('[name=lod][value=all]').check();
  await codecRequest;
  await page.locator('#cancelBtn').click();
  await (await held).abort();
  await context.unroute('**/decoders/laz/voxelkloud_wasm_codecs_bg.wasm');
  await page.waitForFunction(() => globalThis.codecTerminations > 0);
  assert.match(await status(), /canceled/);
  for (const file of ['draco/draco_decoder.wasm', 'basis/basis_transcoder.wasm', 'laz/voxelkloud_wasm_codecs_bg.wasm']) {
    assert.ok((await page.request.get(`${base}decoders/${file}`)).ok());
  }

  // Fail before global network fetch for dataset-owned external references.
  const xml = '<gml:MultiPoint xmlns:gml="http://www.opengis.net/gml" xmlns:xlink="http://www.w3.org/1999/xlink"><gml:pointMember xlink:href="https://outside.invalid/a.gml#p"/></gml:MultiPoint>';
  await page.locator('#mainFile').setInputFiles({ name: 'outside.gml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await page.waitForFunction(() => document.querySelector('#status').dataset.error === 'true');
  assert.match(await status(), /External URLs/);
  await page.locator('#cancelBtn').click();
  assert.match(await status(), /canceled/);
  assert.equal(await pixels(), 0);
  assert.equal(await page.locator('#birdBtn').isDisabled(), true, 'closing the model ends bird mode');
  await page.setViewportSize({ width: 390, height: 844 });
  await cornerMargins(390, 844);
  assert.deepEqual(await page.locator('#canvas').boundingBox(), { x: 0, y: 0, width: 390, height: 844 });
  const mobileTop = await page.evaluate(() => ({ hud: document.querySelector('.hud').getBoundingClientRect().toJSON(), lod: document.querySelector('.lod').getBoundingClientRect().toJSON(), files: document.querySelector('.files').getBoundingClientRect().toJSON() }));
  assert.ok(mobileTop.lod.top > mobileTop.files.bottom && mobileTop.hud.top > mobileTop.lod.bottom, 'mobile LOD sits below file/theme toolbar, status below LOD');
  const legends = await page.locator('.legend').boundingBox(), views = await page.locator('.views').boundingBox(), lod = await page.locator('.lod').boundingBox();
  assert.ok(lod.x > views.x && lod.width > views.width && views.x + views.width < legends.x, 'mobile top-right LOD and bottom controls are separate');
  const mobileFooter = await footer.boundingBox(), mobileNotices = await notices.boundingBox();
  assert.ok(mobileFooter.height <= 20 && mobileFooter.y + mobileFooter.height < legends.y && mobileFooter.x > views.x + views.width &&
    mobileNotices.x + mobileNotices.width <= 390, 'mobile footer stays above legend and clear of view controls with link visible');
  await unifiedTextColors();
  await page.setViewportSize({ width: 390, height: 600 });
  await cornerMargins(390, 600);
  const shortLod = await page.locator('.lod').boundingBox(), shortLegend = await page.locator('.legend').boundingBox();
  assert.ok(shortLod.y + shortLod.height < shortLegend.y, 'short mobile LOD clears the lower legend');
  await page.setViewportSize({ width: 680, height: 390 });
  const compact = await page.evaluate(() => ({ files: document.querySelector('.files').getBoundingClientRect().bottom,
    lodTop: document.querySelector('.lod').getBoundingClientRect().top, lodBottom: document.querySelector('.lod').getBoundingClientRect().bottom,
    hudTop: document.querySelector('.hud').getBoundingClientRect().top }));
  assert.ok(compact.files < compact.lodTop && compact.lodBottom < compact.hudTop, 'mid-width layout does not squeeze the status between toolbars');
  await page.setViewportSize({ width: 844, height: 390 });
  await cornerMargins(844, 390);
  await open('test/fixtures/gml/sample.gml');
  const boxes = [];
  for (const selector of ['.files', '.lod', '.views', '.legend']) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 844 && box.y + box.height <= 390, `${selector} stays inside landscape viewport`);
    for (const [other, previous] of boxes) {
      assert.ok(box.x >= previous.x + previous.width || previous.x >= box.x + box.width ||
        box.y >= previous.y + previous.height || previous.y >= box.y + box.height,
      `${selector} does not cover ${other} in landscape`);
    }
    boxes.push([selector, box]);
  }
  for (const input of await page.locator('[name=lod]').all()) {
    const box = await input.boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 844 && box.y + box.height <= 390, 'every LOD remains operable');
  }
  assert.ok(await page.locator('.legend').evaluate(element => element.scrollHeight > element.clientHeight), 'short landscape legend scrolls');
  await page.locator('[name=lod][value="2"]').check();
  await visible('landscape LOD 2');
  await page.locator('#topBtn').click();
  await page.locator('#themeBtn').click();
  assert.ok(await pixels() > 20, 'landscape view and theme controls remain usable');
  await page.setViewportSize({ width: 320, height: 260 });
  await cornerMargins(320, 260);
  const tiny = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    const lod = document.querySelector('.lod');
    return { lodTop: rect('.lod').top, lodLeft: rect('.lod').left, viewRight: rect('.views').right, filesBottom: rect('.files').bottom,
      hudBottom: rect('.hud').bottom, legendTop: rect('.legend').top,
      scrollable: lod.scrollWidth > lod.clientWidth,
      hudScrollable: document.querySelector('.hud').scrollHeight > document.querySelector('.hud').clientHeight };
  });
  assert.ok(tiny.lodTop > tiny.filesBottom && tiny.viewRight < tiny.lodLeft && tiny.hudBottom < tiny.legendTop, 'very short layout keeps visible panels separate');
  assert.ok(tiny.scrollable, 'very narrow LOD scrolls horizontally without hiding options');
  assert.ok(tiny.hudScrollable, 'long model details remain scrollable without covering the legend');
  const tinyFooter = await footer.boundingBox();
  assert.ok(tinyFooter.y >= tiny.hudBottom && tinyFooter.y + tinyFooter.height < tiny.legendTop &&
    tinyFooter.x > tiny.viewRight, 'small-screen footer does not overlap HUD or control panels');
  assert.ok(await page.locator('.views').evaluate(element => element.scrollHeight > element.clientHeight), 'short viewport can scroll to the bird icon');
  await page.locator('#birdBtn').click();
  assert.equal(await page.locator('#birdBtn').getAttribute('aria-pressed'), 'true');
  await page.locator('#birdBtn').click();
  await page.locator('[name=lod][value="4"]').check();
  await page.locator('#projectionBtn').click();
  assert.equal(await page.locator('#projectionBtn').getAttribute('aria-pressed'), 'false', 'view control is operable');
  const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const touch = await touchContext.newPage();
  await touch.goto(base);
  await touch.locator('#themeBtn').tap();
  await touch.locator('#plateauBtn').tap();
  await touch.touchscreen.tap(4, 4);
  assert.equal(await touch.locator('#plateauDialog').isVisible(), false, 'tap outside closes the dialog on touch screens');
  await touch.locator('[name=lod][value="2"]').check();
  await touch.locator('#projectionBtn').tap();
  assert.equal(await touch.locator('#projectionBtn').getAttribute('aria-pressed'), 'true');
  await touch.setViewportSize({ width: 844, height: 390 });
  await touch.locator('#themeBtn').tap();
  await touch.locator('[name=lod][value="4"]').check();
  await touch.locator('#topBtn').tap();
  await touchContext.close();
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert.ok(requests.slice(requestStart).every(({ path, method }) => path.startsWith(prefix) && method === 'GET'));
  assert.equal((await page.request.get(`${base}samples/gml/sample.gml`)).status(), 404);
  console.log(`PASS: static ${prefix} local File WebGL / codecs / UI / touch; external requests=0`);
} finally {
  await context.close();
}
}
// Explicit online search and selection are exercised with synthetic assets; no live data is bundled or fetched.
const online = await browser.newContext();
try {
  const page = await online.newPage();
  const onlineErrors = [];
  page.on('console', message => { if (message.type() === 'error') onlineErrors.push(message.text()); });
  page.on('pageerror', error => onlineErrors.push(error.message));
  const root = 'https://assets.cms.plateau.reearth.io/assets/80/45b2b1-5a88-40ab-9877-70b540b8707e/synthetic/';
  const api = 'https://api.plateauview.mlit.go.jp';
  const remote = [];
  await online.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(`http://127.0.0.1:${server.address().port}/`) || url.startsWith('data:') || url.startsWith('blob:')) return route.continue();
    remote.push(url);
    const headers = { 'access-control-allow-origin': '*' };
    if (url === `${api}/datacatalog/graphql`) {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' } });
      assert.equal(route.request().postDataJSON().variables.name, '新宿');
      return route.fulfill({ headers, json: { data: { areas: [{ name: '新宿区', code: '13104' }] } } });
    }
    if (url === `${api}/datacatalog/citygml/mm:53394653` || url === `${api}/datacatalog/citygml/13104`) return route.fulfill({ headers, json: { cities: [{ cityName: 'Test', featureTypes: { bldg: { name: 'Buildings' } }, files: { bldg: [{ code: '53394653', maxLod: 2, url: `${root}sample.gml` }] } }] } });
    if (url === `${api}/datacatalog/plateau-datasets`) return route.fulfill({ headers, json: { latest_datasets: [{ city_code: '13106', format: '3D Tiles', name: 'Test tiles', lod: '2', url: `${api}/datacatalog/3dtiles/13106-bldg-lod2-latest/tileset.json` }] } });
    if (url === `${api}/datacatalog/3dtiles/13106-bldg-lod2-latest/tileset.json`) {
      const tileset = JSON.parse(await readFile('test/fixtures/tiles/tileset.json', 'utf8'));
      for (const child of tileset.root.children) child.content.uri = new URL(child.content.uri, root).href;
      return route.fulfill({ headers, json: tileset });
    }
    if (url.startsWith(root)) {
      const name = url.slice(root.length);
      const path = name === 'sample.gml' ? 'test/fixtures/gml/sample.gml' : `test/fixtures/tiles/${name}`;
      if (!['sample.gml', 'building.gltf', 'building.b3dm'].includes(name)) throw new Error(`Unexpected remote asset: ${url}`);
      return route.fulfill({ headers, body: await readFile(path), contentType: name.endsWith('.json') || name.endsWith('.gltf') ? 'application/json' : 'application/octet-stream' });
    }
    throw new Error(`Unexpected network request: ${url}`);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(remote.length, 0, 'no network before explicit PLATEAU search');
  assert.equal(await page.locator('#plateauClose').count(), 0);
  assert.equal(await page.locator('#plateauSearch button').count(), 0, 'search form has no submit button');
  const baseBorder = await page.locator('#themeBtn').evaluate(element => getComputedStyle(element).borderColor);
  const baseBackground = await page.locator('#themeBtn').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'themeBtn');
  assert.equal(await page.locator('#themeBtn').evaluate(element => getComputedStyle(element).outlineStyle), 'none');
  assert.notEqual(await page.locator('#themeBtn').evaluate(element => getComputedStyle(element).backgroundColor), baseBackground, 'keyboard focus remains visible without a ring');
  await page.locator('#themeBtn').focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.name), 'lod');
  assert.equal(await page.locator('.lod label:has(input:focus-visible)').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'radio focus has no ring');
  await page.locator('#themeBtn').click();
  assert.equal(await page.locator('#themeBtn').evaluate(element => getComputedStyle(element).borderColor), baseBorder, 'click does not add a border');
  await page.locator('#themeBtn').click();
  await page.locator('#plateauBtn').click();
  const initialDialog = await page.locator('#plateauDialog').boundingBox();
  await page.mouse.click(initialDialog.x + 4, initialDialog.y + 4);
  assert.equal(await page.locator('#plateauDialog').isVisible(), true, 'clicking dialog padding does not close it');
  await page.locator('#plateauKind').click();
  assert.equal(await page.locator('#plateauKind').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'focused select has no focus ring');
  await page.mouse.click(4, 4);
  assert.equal(await page.locator('#plateauDialog').isVisible(), false, 'backdrop click closes the dialog');
  await page.locator('#plateauBtn').click();
  await page.locator('#plateauCode').fill('53394653');
  assert.equal(await page.locator('#plateauCode').evaluate(element => getComputedStyle(element).outlineStyle), 'none', 'focused input has no focus ring');
  await page.locator('#plateauCode').press('Enter');
  await page.locator('#plateauResults button').first().waitFor();
  assert.equal(remote.length, 1, 'search fetches only the catalog');
  await page.locator('#plateauResults button').first().click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Viewing:'));
  assert.ok(remote.includes(`${root}sample.gml`));
  await page.locator('#plateauBtn').click();
  await page.locator('#plateauCode').fill('新宿');
  await page.locator('#plateauCode').press('Enter');
  await page.getByRole('button', { name: '新宿区 · 13104' }).click();
  assert.equal(await page.locator('#plateauCode').inputValue(), '13104');
  await page.locator('#plateauResults button').first().waitFor();
  assert.ok(remote.includes(`${api}/datacatalog/citygml/13104`));
  await page.locator('#plateauResults button').first().click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Viewing:'));
  await page.locator('#plateauBtn').click();
  await page.locator('#plateauKind').selectOption('tiles');
  await page.locator('#plateauCode').fill('13106');
  await page.locator('#plateauCode').press('Enter');
  await page.locator('#plateauResults button').first().waitFor();
  assert.ok(!remote.some(url => url.endsWith('/tileset.json')), 'tiles are not fetched until selection');
  const tileResponse = page.waitForResponse(response => response.url() === `${root}building.b3dm`, { timeout: 8000 });
  await page.locator('#plateauResults button').first().click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Viewing: Test tiles'));
  try { await tileResponse; } catch (error) { throw new Error(`Tile request absent: ${await page.locator('#status').textContent()} · ${remote.join(', ')} · ${onlineErrors.join(', ')}`, { cause: error }); }
  assert.ok(remote.includes(`${root}building.b3dm`));
  await page.locator('#cancelBtn').click();
  await page.locator('#plateauBtn').click();
  await page.locator('#plateauKind').selectOption('gml');
  for (const [width, height] of [[560, 476], [390, 600], [320, 420], [844, 390], [320, 260]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector('#plateauDialog'), action = document.querySelector('#plateauCode').getBoundingClientRect();
      const box = dialog.getBoundingClientRect();
      return { left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        inputBottom: action.bottom, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
        blankMessage: getComputedStyle(document.querySelector('#plateauMessage')).display,
        blankResults: getComputedStyle(document.querySelector('#plateauResults')).display };
    });
    assert.ok(layout.left >= 0 && layout.top >= 0 && layout.right <= width && layout.bottom <= height, `dialog fits ${width}x${height}`);
    assert.equal(layout.blankMessage, 'none');
    assert.equal(layout.blankResults, 'none');
    assert.ok(layout.scrollWidth <= layout.clientWidth, `empty dialog has no horizontal overflow at ${width}x${height}`);
    if (height >= 420) assert.ok(layout.bottom - layout.inputBottom <= 26, 'no phantom gap below input');
  }
  await page.evaluate(() => {
    const list = document.querySelector('#plateauResults');
    for (let i = 0; i < 25; i++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `Model ${i} · ${'verylongunbrokenfilename'.repeat(8)}.gml`;
      list.append(button);
    }
  });
  for (const [width, height] of [[320, 260], [390, 600], [844, 390]]) {
    await page.setViewportSize({ width, height });
    const layout = await page.locator('#plateauDialog').evaluate(dialog => ({ scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight,
      width: dialog.getBoundingClientRect().width, buttonWidth: dialog.querySelector('#plateauResults button').getBoundingClientRect().width }));
    assert.ok(layout.scrollWidth <= layout.clientWidth, `long result fits horizontally at ${width}x${height}`);
    assert.ok(layout.buttonWidth <= layout.width, 'result button stays inside dialog');
    assert.ok(layout.scrollHeight > layout.clientHeight, 'results scroll in the dialog');
  }
  await page.mouse.click(4, 4);
  assert.equal(await page.locator('#plateauDialog').isVisible(), false, 'backdrop remains usable after overflow');
  await page.locator('#plateauBtn').click();
  await page.locator('#plateauCode').fill('123');
  await page.locator('#plateauCode').press('Enter');
  await page.waitForFunction(() => document.querySelector('#plateauMessage').textContent.includes('8-digit mesh'));
  assert.match(await page.locator('#plateauMessage').textContent(), /8-digit mesh/);
  assert.equal(await page.locator('#plateauMessage').evaluate(element => getComputedStyle(element).color), 'rgb(255, 173, 172)');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#plateauDialog').isVisible(), false, 'Escape closes the dialog for keyboard users');
  assert.deepEqual(onlineErrors, []);
  assert.deepEqual(errors, []);
  console.log('PASS: opt-in PLATEAU catalog, GML, 3D Tiles and dependent assets (synthetic HTTP fixtures)');
} finally { await online.close(); }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
