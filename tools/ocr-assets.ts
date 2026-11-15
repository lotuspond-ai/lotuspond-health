// Vite plugin: the files on-device report reading needs (tesseract.js worker, the Tesseract core in three
// WebAssembly flavours, and the English data), served from the app at /ocr/<tesseract.js version>/ so no CDN is
// involved and the app's CSP stays 'self'. Development serves them from node_modules; builds copy them out.
// The server-less preview (--mode artifact) leaves them out: its host takes only text, scripts and images.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Plugin } from 'vite';

const require = createRequire(import.meta.url);

function sources(): { version: string; files: Record<string, () => Buffer> } {
  const pkgDir = path.dirname(require.resolve('tesseract.js/package.json'));
  const coreDir = path.dirname(require.resolve('tesseract.js-core/package.json'));
  const dataDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  const version = (JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')) as { version: string }).version;
  const read = (f: string) => () => fs.readFileSync(f);
  const files: Record<string, () => Buffer> = {
    'worker.min.js': read(path.join(pkgDir, 'dist', 'worker.min.js')),
    // Uncompressed, so the server can send it with Content-Encoding like any other file (the app sets gzip: false).
    'lang/eng.traineddata': () => zlib.gunzipSync(fs.readFileSync(path.join(dataDir, '4.0.0_best_int', 'eng.traineddata.gz'))),
  };
  // The worker picks one by browser support; each embeds its WebAssembly.
  for (const f of ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']) {
    files[`core/${f}`] = read(path.join(coreDir, f));
  }
  return { version, files };
}

export function ocrAssets(opts: { enabled: boolean; base: string }): Plugin {
  const src = sources();
  const dir = `ocr/${src.version}/`;
  return {
    name: 'lotuspond-ocr-assets',
    config: () => ({ define: { __OCR_BASE__: JSON.stringify(opts.enabled ? `${opts.base}${dir}` : null) } }),
    configureServer(server) {
      if (!opts.enabled) return;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const prefix = `/${dir}`;
        if (!url.startsWith(prefix)) return next();
        const load = src.files[url.slice(prefix.length)];
        if (!load) return next();
        res.setHeader('Content-Type', url.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.end(load());
      });
    },
    generateBundle() {
      if (!opts.enabled) return;
      for (const [name, load] of Object.entries(src.files)) this.emitFile({ type: 'asset', fileName: `${dir}${name}`, source: load() });
    },
  };
}
