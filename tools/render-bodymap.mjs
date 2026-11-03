// Pre-renders the 2D body map into public/bodymap/, for each body (female, male): WebP "beauty" images of the anatomy
// from N angles around the vertical axis plus a close-up per organ (two sizes each), lossless palette PNG "ID maps"
// for hit testing, and manifest.<body>.json with the organ colours, projected pin and landmark positions and per-organ
// boxes. File names start with the body's letter (f-, m-) so both sets share one flat folder.
//
//   node tools/render-bodymap.mjs [--body=female|male|all] [--angles=16] [--size=600x900] [--hi=1000x1500] [--ss=1.5]
//                                 [--quality=0.8] [--hi-quality=0.76] [--no-ao] [--url=http://localhost:5230/]
//                                 [--only=a00,heart] [--organs=heart,liver] [--out=dir]
// --only re-renders just the listed angles and close-ups and keeps the rest from the existing manifest;
// --organs limits the close-ups (for trying out settings, with --out pointing elsewhere).
//
// Starts its own Vite dev server unless --url points at one. Rendering runs on the CPU (SwiftShader) in headless
// Chromium, so a full run takes several minutes per body. Re-run it whenever a model or the stage look changes, and
// commit the output. File names carry a content hash, so they can be cached for good.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d;
const outDir = path.resolve(opt('out', path.join(root, 'public', 'bodymap')));
const dims = s => s.split('x').map(Number);
const ANGLES = Number(opt('angles', 16));
const LO = dims(opt('size', '600x900'));
const HI = dims(opt('hi', '1000x1500'));
const SS = Number(opt('ss', 1.5));
const Q = Number(opt('quality', 0.82));
const QHI = Number(opt('hi-quality', 0.76));
const only = opt('only', '') ? new Set(opt('only').split(',')) : null;
const render = [Math.round(HI[0] * SS), Math.round(HI[1] * SS)];
const BODIES = opt('body', 'all') === 'all' ? ['female', 'male'] : [opt('body')];
const sources = JSON.parse(fs.readFileSync(path.join(root, 'tools', 'anatomy', 'sources.json'), 'utf8'));

let chromium;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); }
catch { ({ chromium } = createRequire(path.join(process.execPath, '..', '..', 'lib', 'node_modules', '/'))('playwright')); }

// The app bundles a copy of each body's manifest (Vite does not let code import from public/): start from a
// placeholder for any that is missing, or the render page does not compile.
const bundledManifest = body => path.join(root, 'src', 'components', 'bodymap2d', `manifest.${body}.json`);
for (const body of ['female', 'male']) {
  if (!fs.existsSync(bundledManifest(body))) {
    fs.writeFileSync(bundledManifest(body), JSON.stringify({ version: 0, body, model: { path: `models/anatomy-${body}.glb`, sha: 'none', bytes: 0 }, sizes: {}, idSize: [1, 1], organs: [], angles: [], closeups: {} }));
  }
}

let server = null;
let base = opt('url', '');
if (!base) {
  const { createServer } = await import('vite');
  // No HMR and no file watching: editing sources during a run must not reload the render page.
  server = await createServer({ root, logLevel: 'warn', server: { port: 5296, strictPort: false, host: '127.0.0.1', hmr: false, watch: null } });
  await server.listen();
  base = server.resolvedUrls.local[0];
}

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const problems = [];
fs.mkdirSync(outDir, { recursive: true });

async function renderBody(body) {
  const prefix = `${body[0]}-`;
  // A fresh page per body: the page keeps one model and its meshes.
  const page = await browser.newPage({ viewport: { width: render[0], height: render[1] }, deviceScaleFactor: 1 });
  page.on('pageerror', e => problems.push(`${body}: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${body}: ${m.text().slice(0, 300)}`); });
  // Hash the model before the page loads it: the manifest must name the file these images show.
  const modelFile = `models/anatomy-${body}.glb`;
  const modelPath = path.join(root, 'public', modelFile);
  const hashOf = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
  const model = fs.readFileSync(modelPath);
  try {
    await page.goto(new URL(`tools/bodymap-render.html?body=${body}${args.includes('--no-ao') ? '&ao=0' : ''}`, base).href);
    await page.waitForFunction(() => window.__bodymap, null, { timeout: 300000 });
    if (await page.evaluate(() => window.__bodymap.body()) !== body) throw new Error(`render page did not load the ${body} body`);
    const { organs, colors } = await page.evaluate(() => window.__bodymap.palette());
    const framing = await page.evaluate(() => window.__bodymap.framing());
    const manifestPath = path.join(outDir, `manifest.${body}.json`);
    const previous = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
    const written = new Set();
    const save = (stem, ext, buf) => {
      const name = `${prefix}${stem}.${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10)}.${ext}`;
      fs.writeFileSync(path.join(outDir, name), buf); written.add(name);
      return name;
    };
    const keep = name => { written.add(name); return name; };
    const sizes = [[...LO, Q], [...HI, QHI]];
    const t0 = Date.now();

    const angles = [];
    const backgrounds = [];
    for (let i = 0; i < ANGLES; i++) {
      const stem = `a${String(i).padStart(2, '0')}`;
      const deg = (360 * i) / ANGLES;
      if (only && !only.has(stem) && previous?.angles?.[i]) { const p = previous.angles[i]; angles.push(p); for (const f of [...Object.values(p.image), p.id]) keep(f); continue; }
      const shot = await page.evaluate(([deg, sizes, id]) => window.__bodymap.shot({ kind: 'body', deg }, { sizes, id }), [deg, sizes, LO]);
      const idx = Buffer.from(shot.id.data, 'base64');
      angles.push({
        deg,
        image: { '1x': save(`${stem}-1x`, 'webp', Buffer.from(shot.images[0], 'base64')), '2x': save(`${stem}-2x`, 'webp', Buffer.from(shot.images[1], 'base64')) },
        id: save(`${stem}-id`, 'png', palettePng(shot.id.width, shot.id.height, idx, colors)),
        pins: shot.pins, boxes: shot.boxes, camera: shot.camera,
      });
      backgrounds.push(shot.background);
      console.log(`${body} angle ${stem} (${deg}°) ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }

    const closeups = {};
    const closeupOrgans = opt('organs', '') ? organs.filter(o => opt('organs').split(',').includes(o)) : organs;
    for (const organ of closeupOrgans) {
      if (only && !only.has(organ) && previous?.closeups?.[organ]) { const p = previous.closeups[organ]; closeups[organ] = p; for (const f of Object.values(p.image)) keep(f); continue; }
      const shot = await page.evaluate(([organ, sizes]) => window.__bodymap.shot({ kind: 'organ', organ }, { sizes }), [organ, sizes]);
      closeups[organ] = {
        image: { '1x': save(`${organ}-1x`, 'webp', Buffer.from(shot.images[0], 'base64')), '2x': save(`${organ}-2x`, 'webp', Buffer.from(shot.images[1], 'base64')) },
        landmarks: shot.landmarks, names: shot.names, camera: shot.camera,
      };
      console.log(`${body} close-up ${organ} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
    }

    if (hashOf(fs.readFileSync(modelPath)) !== hashOf(model)) throw new Error(`${modelFile} changed during the render: run it again`);
    const manifest = {
      version: 2, body,
      note: 'Generated by tools/render-bodymap.mjs. Coordinates are fractions of the image (x right, y down); pins and landmarks carry a third value: how far (metres) the point sits in front of (+) or behind (-) the view centre.',
      license: `${sources.outputLicense.spdx}: ${sources.outputLicense.text}`,
      model: { path: modelFile, sha: hashOf(model), bytes: model.length },
      sizes: { '1x': LO, '2x': HI }, idSize: LO,
      background: backgrounds.length ? hex(backgrounds.sort((a, b) => a[1] - b[1])[backgrounds.length >> 1]) : previous?.background ?? '#0c2528',
      camera: framing,
      organs: organs.map((id, i) => ({ id, index: i + 1, color: hex(colors[i + 1]) })),
      angles, closeups,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + '\n');
    if (outDir === path.join(root, 'public', 'bodymap')) fs.writeFileSync(bundledManifest(body), bundled(manifest));
    // remove this body's old files only (and, on a full render, images left from the single-body layout)
    for (const f of fs.readdirSync(outDir)) {
      const stale = f.startsWith(prefix) ? !written.has(f) : (!only && /^(a\d\d|[a-z]+)-(1x|2x|id)\.[0-9a-f]{10}\.(webp|png)$/.test(f)) || (!only && f === 'manifest.json');
      if (stale) fs.rmSync(path.join(outDir, f));
    }

    const total = [...written].reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
    const sum = re => [...written].filter(f => re.test(f)).reduce((s, f) => s + fs.statSync(path.join(outDir, f)).size, 0);
    const kb = n => `${Math.round(n / 1024)} KB`;
    console.log(`\n${body}: wrote ${written.size} files, ${kb(total)} in total: 1x ${kb(sum(/-1x\./))}, 2x ${kb(sum(/-2x\./))}, id maps ${kb(sum(/-id\./))}; manifest ${kb(fs.statSync(manifestPath).size)}`);
  } finally {
    await page.close();
  }
}

try {
  for (const body of BODIES) await renderBody(body);
} finally {
  const shown = [...new Set(problems)].filter(m => !/THREE.Clock|GPU stall/.test(m));
  if (shown.length) { console.log(`\nbrowser messages:\n${shown.join('\n')}`); process.exitCode = 1; }
  await browser.close();
  await server?.close();
}

function hex(rgb) { return `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`; }

/** The app's copy: what the 2D view reads, without the camera positions and notes. */
function bundled(m) {
  const strip = ({ camera: _camera, ...rest }) => rest;
  return JSON.stringify({ ...m, note: undefined, camera: undefined, angles: m.angles.map(strip), closeups: Object.fromEntries(Object.entries(m.closeups).map(([k, v]) => [k, strip(v)])) }) + '\n';
}

/** Indexed-colour PNG (4-bit when the palette allows), no colour-space chunks: browsers decode the exact values. */
function palettePng(w, h, idx, palette) {
  const bits = palette.length <= 16 ? 4 : 8;
  const stride = bits === 4 ? Math.ceil(w / 2) : w;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1) + 1; // filter byte 0 (none) first
    for (let x = 0; x < w; x++) {
      const v = idx[y * w + x];
      if (bits === 8) raw[o + x] = v; else raw[o + (x >> 1)] |= x & 1 ? v : v << 4;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = bits; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(palette.flat())), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
