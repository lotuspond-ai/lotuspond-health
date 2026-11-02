import { createRequire } from 'module';
const { chromium } = createRequire(import.meta.url)('playwright');
const shots = JSON.parse(process.argv[2]);
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 760, height: 760 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => m.type() === 'error' && errs.push(m.text()));
for (const [name, qs] of shots) {
  await p.goto(`http://localhost:5199/tools/model-preview.html?${qs}`); await p.waitForFunction(() => document.title === 'ready', null, { timeout: 90000 }).catch(e => { console.log('ERR', errs.join('\n')); throw e; });
  await p.screenshot({ path: `shots/${name}.png` });
}
console.log(errs.join('\n') || 'ok'); await b.close();
