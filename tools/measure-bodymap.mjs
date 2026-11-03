// Measures the body map in headless Chromium: what the first view downloads, and what the 3D stage costs per frame.
//   node tools/measure-bodymap.mjs <app url> [--3d] [--dpr=1] [--json=out.json]
// Signs up (or in) a measurement account with sample data, then opens the body map in a fresh browser profile.
// --no-orbit skips the orbit (canvas size and load only). --repeat reloads once the service worker is ready and reports what still goes to the network.
// --3d also measures the interactive stage: WebGL is counted at the context level (draw calls, triangles,
// framebuffer passes, shader programs), and a fixed orbit (a scripted drag) gives frame intervals.
// SwiftShader renders on the CPU, so absolute frame times are not representative; compare runs with each other.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const args = process.argv.slice(2);
const url = args.find(a => !a.startsWith('--')) ?? 'http://localhost:8831/';
const opt = k => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1];
const want3d = args.includes('--3d');
const studio = args.includes('--studio');
// --cores=8 makes the page see a desktop-class CPU (the app picks its default quality from the core count).
const cores = opt('cores') ? Number(opt('cores')) : null;
const dpr = Number(opt('dpr') ?? 1);
const email = opt('email') ?? 'measure@example.com';
const password = 'measure the lily pond';
const stateFile = path.join(os.tmpdir(), 'lotuspond-measure-state.json');

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });

// 1. Account with sample data (kept between runs).
{
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const api = (path, body) => page.evaluate(async ([p, b]) => {
    const r = await fetch(`api/${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return r.status;
  }, [path, body]);
  if (await api('auth/login', { email, password }) !== 200) {
    const s = await api('auth/register', { email, password, displayName: 'Measure' });
    if (s !== 200 && s !== 201) throw new Error(`could not create the measurement account (${s})`);
  }
  await page.reload({ waitUntil: 'networkidle' });
  const sample = page.getByRole('button', { name: 'Explore with sample data' });
  if (await sample.isVisible().catch(() => false)) { await sample.click(); await page.getByRole('heading', { name: 'Overview' }).waitFor(); }
  fs.writeFileSync(stateFile, JSON.stringify(await ctx.storageState()));
  await ctx.close();
}

// 2. First view in a fresh profile (empty HTTP cache, no service worker).
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr, storageState: stateFile });
if (cores) await ctx.addInitScript(n => Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { get: () => n }), cores);
await ctx.addInitScript(() => {
  const st = { frames: [], cur: null, programs: 0, fb: null, fbDirty: true };
  window.__gl = st;
  const close = () => { if (st.cur) st.cur.end = performance.now(); st.cur = null; };
  const loop = () => { close(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  const rec = () => { if (!st.cur) { st.cur = { t: performance.now(), calls: 0, tris: 0, passes: 0 }; st.frames.push(st.cur); st.fbDirty = true; } return st.cur; };
  const draw = (mode, count, inst = 1) => {
    const f = rec(); f.calls++; if (mode === 4) f.tris += (count / 3) * inst;
    if (st.fbDirty) { f.passes++; st.fbDirty = false; }
  };
  for (const proto of [WebGLRenderingContext.prototype, globalThis.WebGL2RenderingContext?.prototype].filter(Boolean)) {
    const o = { ...Object.fromEntries(['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'bindFramebuffer', 'createProgram'].map(k => [k, proto[k]])) };
    proto.drawElements = function (m, c) { draw(m, c); return o.drawElements.apply(this, arguments); };
    proto.drawArrays = function (m, f0, c) { draw(m, c); return o.drawArrays.apply(this, arguments); };
    if (o.drawElementsInstanced) proto.drawElementsInstanced = function (m, c, t, off, n) { draw(m, c, n); return o.drawElementsInstanced.apply(this, arguments); };
    if (o.drawArraysInstanced) proto.drawArraysInstanced = function (m, f0, c, n) { draw(m, c, n); return o.drawArraysInstanced.apply(this, arguments); };
    proto.bindFramebuffer = function (t, fb) { if (fb !== st.fb) { st.fb = fb; st.fbDirty = true; } return o.bindFramebuffer.apply(this, arguments); };
    proto.createProgram = function () { st.programs++; return o.createProgram.apply(this, arguments); };
  }
});
const page = await ctx.newPage();
const net = [];
page.on('requestfinished', async req => {
  const res = await req.response(); const sz = await req.sizes().catch(() => null);
  net.push({ url: req.url().replace(url, ''), type: req.resourceType(), status: res?.status(), bytes: sz ? sz.responseBodySize + sz.responseHeadersSize : 0, sw: res?.fromServiceWorker() ?? false });
});
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });

const t0 = Date.now();
await page.goto(url, { waitUntil: 'networkidle' });
await page.locator('.stage').waitFor();
await page.waitForTimeout(2500);
const firstView = summarize(net);
const firstViewMs = Date.now() - t0;
const result = { url, dpr, firstView: { ...firstView, settledMs: firstViewMs }, errors };

if (want3d) {
  const btn = page.getByRole('button', { name: /Explore in 3D/ });
  if (await btn.isVisible().catch(() => false)) await btn.click();
  const t3 = Date.now();
  await page.waitForFunction(() => window.__gl.frames.some(f => f.calls > 20), null, { timeout: 120000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  if (studio) {
    const chip = page.getByRole('button', { name: 'Studio light' });
    if (await chip.getAttribute('aria-pressed') !== 'true') await chip.click();
    await page.waitForTimeout(4000);
  }
  result.threeD = { readyMs: Date.now() - t3, studio, cores: await page.evaluate(() => navigator.hardwareConcurrency), ...summarize(net.slice(firstView.requests)) };
  result.threeD.programs = await page.evaluate(() => window.__gl.programs);
  // Idle: frames rendered with nothing happening (frameloop="demand" should render none).
  const idleFrom = await page.evaluate(() => window.__gl.frames.length);
  await page.waitForTimeout(2000);
  result.threeD.idleFrames = await page.evaluate(n => window.__gl.frames.length - n, idleFrom);
  result.threeD.canvas = await page.evaluate(() => { const c = document.querySelector('.stage canvas'); return { width: c.width, height: c.height }; });
}
if (want3d && !args.includes('--no-orbit')) {
  // Fixed orbit: a 400 px drag across the stage in 120 pointer moves, about 16 ms apart.
  const box = await page.locator('.stage canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const from = await page.evaluate(() => window.__gl.frames.length);
  await page.mouse.move(cx - 200, cy); await page.mouse.down();
  const tStart = Date.now();
  for (let i = 0; i <= 120; i++) { await page.mouse.move(cx - 200 + (400 * i) / 120, cy + Math.sin(i / 10) * 30); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const orbitMs = Date.now() - tStart;
  const frames = await page.evaluate(n => window.__gl.frames.slice(n), from);
  const drawn = frames.filter(f => f.calls > 0);
  const gaps = drawn.slice(1).map((f, i) => f.t - drawn[i].t).sort((a, b) => a - b);
  const q = p => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0);
  const per = (list, k) => Math.round(list.reduce((s, f) => s + f[k], 0) / Math.max(1, list.length));
  const cost = list => ({ drawCalls: per(list, 'calls'), triangles: per(list, 'tris'), passes: per(list, 'passes') });
  result.threeD.orbit = {
    ms: orbitMs, framesRendered: drawn.length, fps: +(drawn.length / (orbitMs / 1000)).toFixed(1),
    frameIntervalMs: { median: q(0.5), p90: q(0.9) },
    perFrame: cost(drawn), firstFrames: cost(drawn.slice(0, 8)), lastFrames: cost(drawn.slice(-8)),
    tierAfter: await page.locator('.stage3d').getAttribute('data-tier').catch(() => null),
  };
}
// --repeat: wait for the service worker to settle, then load again and see what still goes to the network.
if (args.includes('--repeat')) {
  result.serviceWorker = await page.evaluate(() => Promise.race([navigator.serviceWorker?.ready.then(() => true) ?? false, new Promise(r => setTimeout(() => r(false), 15000))]));
  await page.waitForTimeout(12000);
  const from = net.length;
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.stage').waitFor();
  await page.waitForTimeout(2500);
  const again = net.slice(from);
  result.repeatView = { ...summarize(again), networkKB: Math.round(again.filter(r => !r.sw).reduce((s, r) => s + r.bytes, 0) / 1024), caches: await page.evaluate(async () => (await caches.keys()).join(', ')).catch(() => '') };
}
result.errors = errors;
console.log(JSON.stringify(result, null, 2));
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(result, null, 2));
await browser.close();

function summarize(list) {
  const by = t => list.filter(r => r.type === t);
  const sum = l => l.reduce((s, r) => s + r.bytes, 0);
  const kb = n => Math.round(n / 1024);
  const model = list.filter(r => /models\//.test(r.url));
  const three = list.filter(r => /Stage|three|ThreeStage/i.test(r.url));
  return {
    requests: list.length, totalKB: kb(sum(list)), jsKB: kb(sum(by('script'))), jsFiles: by('script').length,
    imageKB: kb(sum(by('image'))), modelKB: kb(sum(model)), threeChunkKB: kb(sum(three)), fromServiceWorker: list.filter(r => r.sw).length,
    files: list.map(r => `${r.status} ${r.type} ${kb(r.bytes)}KB ${r.url.slice(0, 80)}${r.sw ? ' (sw)' : ''}`),
  };
}
