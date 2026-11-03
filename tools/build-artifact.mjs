// Builds dist-artifact/: a server-less preview for hosts that only serve text/script/image types.
// Accounts and records are kept in the viewer's browser (VITE_BACKEND=browser). Only the app is built (`--mode
// artifact`): the host has no server routes and passes only a #hash into the page, so the app opens sign-in, or
// sign-up with #signup, and its website links (Privacy, Terms, home) go to the live site in a new tab.
// The model ships as base64 text, raw ESC bytes in scripts are escaped, and index.html is body-only.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const out = 'dist-artifact';
execSync(`npx vite build --mode artifact --outDir ${out} --emptyOutDir`, { stdio: 'inherit', env: { ...process.env, VITE_MODEL_PATH: 'models/anatomy.b64.txt', VITE_BACKEND: 'browser' } });
fs.writeFileSync(`${out}/models/anatomy.b64.txt`, fs.readFileSync('public/models/anatomy.glb').toString('base64'));
fs.rmSync(`${out}/models/anatomy.glb`);
// Website imagery from public/site is not used by the app, and the preview never registers the service worker.
fs.rmSync(`${out}/site`, { recursive: true, force: true });
fs.rmSync(`${out}/sw.js`, { force: true });
// The artifact host's policy admits fonts from Google Fonts or data: URIs only, so the self-hosted faces are inlined.
for (const f of fs.readdirSync(`${out}/assets`).filter(n => n.endsWith('.css'))) {
  const p = `${out}/assets/${f}`;
  const css = fs.readFileSync(p, 'utf8').replace(/url\(\.\/([\w.-]+\.woff2)\)/g, (_, font) =>
    `url(data:font/woff2;base64,${fs.readFileSync(`${out}/assets/${font}`).toString('base64')})`);
  fs.writeFileSync(p, css);
}
for (const f of fs.readdirSync(`${out}/assets`).filter(n => n.endsWith('.woff2'))) fs.rmSync(`${out}/assets/${f}`);
for (const f of fs.readdirSync(`${out}/assets`)) {
  if (!/\.(m?js|css)$/.test(f)) continue; // fonts and images are binary and stay as they are
  const p = `${out}/assets/${f}`, b = fs.readFileSync(p);
  if (b.includes(0x1b)) fs.writeFileSync(p, b.toString('latin1').replaceAll('\x1b', '\\x1b'), 'latin1');
}
const html = fs.readFileSync(`${out}/app.html`, 'utf8');
const tags = [...html.matchAll(/<(link|script|title|meta name="theme-color")[^>]*>(?:[^<]*<\/(?:title|script)>)?/g)].map(m => m[0]).filter(t => !/name="viewport"|charset/.test(t));
fs.writeFileSync(`${out}/index.html`, tags.join('\n') + '\n<div id="root"></div>\n');
fs.rmSync(`${out}/app.html`);
console.log('artifact build ready:', fs.readdirSync(out, { recursive: true }).join(', '));
