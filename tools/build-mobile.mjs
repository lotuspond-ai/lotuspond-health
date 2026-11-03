// Builds dist-mobile/: the app shell for the iOS and Android projects (`cap sync` copies it in; webDir in
// capacitor.config.ts). Only the app is built (`--mode mobile`), with relative paths, and its entry becomes
// index.html, which the native shells load. It calls the API at VITE_API_ORIGIN, or the public site by default:
//   VITE_API_ORIGIN=http://192.168.1.20:8787 npm run build:mobile    # test against `npm run local` on your computer
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const out = 'dist-mobile';
execSync('npx tsc -b', { stdio: 'inherit' });
execSync(`npx vite build --mode mobile --outDir ${out} --emptyOutDir`, { stdio: 'inherit', env: { ...process.env, VITE_BACKEND: 'server' } });
// Website imagery from public/site is not used by the app, and the service worker never runs in it.
fs.rmSync(`${out}/site`, { recursive: true, force: true });
fs.rmSync(`${out}/sw.js`, { force: true });
fs.renameSync(`${out}/app.html`, `${out}/index.html`);
console.log(`mobile build ready in ${out}/ (API: ${process.env.VITE_API_ORIGIN || 'the public site'})`);
