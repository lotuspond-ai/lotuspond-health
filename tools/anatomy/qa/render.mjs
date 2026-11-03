// QA renderer for the anatomy build: draws sets of meshes to PNG in headless Chromium (three.js, software GL).
//
//   node tools/anatomy/qa/render.mjs spec.json
//
// spec.json: { width?, height?, background?, views: [{ out, title?, meshes: [{ pos, idx, color, opacity? }],
//   camera: { dir: [x,y,z], up?: [0,1,0], target?: [x,y,z], radius?: metres, ortho?: bool }, clip?: [{ normal, constant }] }] }
// pos/idx are absolute paths to float32 xyz / uint32 triangle files (tools/anatomy/lib/qa.py writes them).
// A view with no target/radius is framed on its meshes. Clipping keeps points where dot(normal, p) + constant >= 0.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = createRequire(path.join(process.execPath, '..', '..', 'lib', 'node_modules', '/'))('playwright')); }

const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const threeDir = path.join(root, 'node_modules', 'three', 'build');

const PAGE = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#000">
<script type="importmap">{ "imports": { "three": "/three/three.module.js" } }</script>
<script type="module">
import * as THREE from 'three';
const spec = await (await fetch('/spec')).json();
const W = spec.width ?? 900, H = spec.height ?? 700;
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setPixelRatio(1); r.setSize(W, H, false); r.localClippingEnabled = true;
r.toneMapping = THREE.ACESFilmicToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(r.domElement);
async function geom(m) {
  const [p, i] = await Promise.all([fetch('/file?p=' + encodeURIComponent(m.pos)).then(x => x.arrayBuffer()), fetch('/file?p=' + encodeURIComponent(m.idx)).then(x => x.arrayBuffer())]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(p), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint32Array(i), 1));
  g.computeVertexNormals(); g.computeBoundingBox();
  return g;
}
window.renderView = async (k) => {
  const view = spec.views[k];
  const scene = new THREE.Scene(); scene.background = new THREE.Color(spec.background ?? '#0f262a');
  scene.add(new THREE.HemisphereLight('#ffffff', '#303838', 1.25));
  const d1 = new THREE.DirectionalLight('#ffffff', 2.0);
  const d2 = new THREE.DirectionalLight('#9fd6dd', 0.8);
  const planes = (view.clip ?? []).map(c => new THREE.Plane(new THREE.Vector3(...c.normal), c.constant));
  const box = new THREE.Box3(); const objs = [];
  for (const m of view.meshes) {
    const g = await geom(m);
    const op = m.opacity ?? 1;
    const mat = new THREE.MeshStandardMaterial({ color: m.color ?? '#cccccc', roughness: 0.6, metalness: 0, side: THREE.DoubleSide,
      transparent: op < 1, opacity: op, depthWrite: op >= 1, clippingPlanes: planes });
    const mesh = new THREE.Mesh(g, mat); if (op < 1) mesh.renderOrder = 2;
    scene.add(mesh); objs.push(mesh); box.union(g.boundingBox);
  }
  const c = view.camera ?? {};
  const dir = new THREE.Vector3(...(c.dir ?? [0, 0, 1])).normalize();
  const up = new THREE.Vector3(...(c.up ?? [0, 1, 0]));
  const target = c.target ? new THREE.Vector3(...c.target) : box.getCenter(new THREE.Vector3());
  const radius = c.radius ?? box.getSize(new THREE.Vector3()).length() / 2;
  let cam;
  if (c.ortho) {
    const a = W / H; cam = new THREE.OrthographicCamera(-radius * a, radius * a, radius, -radius, 0.001, 50);
    cam.position.copy(target).addScaledVector(dir, 10);
  } else {
    cam = new THREE.PerspectiveCamera(30, W / H, 0.005, 50);
    cam.position.copy(target).addScaledVector(dir, radius / Math.tan(THREE.MathUtils.degToRad(15)));
  }
  cam.up.copy(up); cam.lookAt(target);
  d1.position.copy(cam.position).add(new THREE.Vector3(0.6, 1.2, 0.4)); scene.add(d1);
  d2.position.copy(target).addScaledVector(dir, -2).add(new THREE.Vector3(0, 0.5, 0)); scene.add(d2);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  for (const o of objs) { o.geometry.dispose(); o.material.dispose(); }
  return url;
};
window.ready = true;
</script>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/') { res.setHeader('content-type', 'text/html'); return res.end(PAGE); }
  if (u.pathname === '/spec') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(spec)); }
  if (u.pathname.startsWith('/three/')) {
    res.setHeader('content-type', 'text/javascript');
    return fs.createReadStream(path.join(threeDir, path.basename(u.pathname))).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  }
  if (u.pathname === '/file') {
    const p = path.resolve(u.searchParams.get('p'));
    return fs.createReadStream(p).on('error', () => { res.statusCode = 404; res.end(); }).pipe(res);
  }
  res.statusCode = 404; res.end();
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: spec.width ?? 900, height: spec.height ?? 700 } });
  page.on('pageerror', e => console.error('page error:', e.message));
  await page.goto(base);
  await page.waitForFunction('window.ready === true', null, { timeout: 120000 });
  for (let k = 0; k < spec.views.length; k++) {
    const url = await page.evaluate(k => window.renderView(k), k);
    const out = spec.views[k].out;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(url.split(',')[1], 'base64'));
    console.log('wrote', out);
  }
} finally {
  await browser.close(); server.close();
}
