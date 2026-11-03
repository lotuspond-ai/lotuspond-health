// Builds dist-artifact/: a server-less preview for hosts that only serve text/script/image types.
// Accounts and records are kept in the viewer's browser (VITE_BACKEND=browser). The model ships as
// base64 text, raw ESC bytes in bundles are escaped, and index.html is body-only.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const out = 'dist-artifact';
execSync(`npx vite build --outDir ${out} --emptyOutDir`, { stdio: 'inherit', env: { ...process.env, VITE_MODEL_PATH: 'models/anatomy.b64.txt', VITE_BACKEND: 'browser' } });
fs.writeFileSync(`${out}/models/anatomy.b64.txt`, fs.readFileSync('public/models/anatomy.glb').toString('base64'));
fs.rmSync(`${out}/models/anatomy.glb`);
for (const f of fs.readdirSync(`${out}/assets`)) {
  const p = `${out}/assets/${f}`, b = fs.readFileSync(p);
  if (b.includes(0x1b)) fs.writeFileSync(p, b.toString('latin1').replaceAll('\x1b', '\\x1b'), 'latin1');
}
const html = fs.readFileSync(`${out}/index.html`, 'utf8');
const tags = [...html.matchAll(/<(link|script|title|meta name="theme-color")[^>]*>(?:[^<]*<\/(?:title|script)>)?/g)].map(m => m[0]).filter(t => !/name="viewport"|charset/.test(t));
fs.writeFileSync(`${out}/index.html`, tags.join('\n') + '\n<div id="root"></div>\n');
console.log('artifact build ready:', fs.readdirSync(out, { recursive: true }).join(', '));
