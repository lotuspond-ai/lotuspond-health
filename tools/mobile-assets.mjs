// App icon and launch screens for the iOS and Android projects: `npm run mobile:assets`.
//
// 1. Renders the lotus (same artwork as Logo in src/components/ui.tsx) into assets/*.png.
// 2. Runs @capacitor/assets to write every size iOS and Android need.
// 3. Puts back the Android adaptive icon, which is a vector (res/drawable/ic_launcher_foreground.xml) so it stays
//    sharp at every density and doubles as the Android 13+ themed icon; @capacitor/assets would replace it with
//    upscaled bitmaps.
//
// Needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`).
import { createRequire } from 'module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright');
const POND = '#0c2528';

// The lotus in a 64-unit box; its visual centre is (32, 33.5).
const LOTUS = `
  <path d="M32 14c5 6 7 12 7 18s-3 12-7 16c-4-4-7-10-7-16s2-12 7-18z" fill="#e2869e"/>
  <path d="M14 30c7 0 12 3 15 8 2 3 3 7 3 10-6 0-12-2-15-7-2-3-3-7-3-11zM50 30c-7 0-12 3-15 8-2 3-3 7-3 10 6 0 12-2 15-7 2-3 3-7 3-11z" fill="#f2b3c4"/>
  <path d="M12 50c6 2 13 3 20 3s14-1 20-3" stroke="#5fbf95" stroke-width="3" fill="none" stroke-linecap="round"/>`;

/** Lotus scaled so its 40-unit width spans `frac` of a `size` px square, centred. */
const lotus = (size, frac) => {
  const s = (size * frac) / 40;
  return `<g transform="translate(${size / 2 - 32 * s} ${size / 2 - 33.5 * s}) scale(${s})">${LOTUS}</g>`;
};
const pond = (size, glow) => `
  <defs><radialGradient id="g" cx="50%" cy="42%" r="62%"><stop offset="0" stop-color="#173f44"/><stop offset="1" stop-color="${POND}"/></radialGradient></defs>
  <rect width="${size}" height="${size}" fill="${glow ? 'url(#g)' : POND}"/>`;
const svg = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`;

const sources = {
  // Full-bleed square; iOS and Android round the corners themselves.
  'icon-only': svg(1024, pond(1024, true) + lotus(1024, 0.6)),
  splash: svg(2732, pond(2732, false) + lotus(2732, 0.2)),
  'splash-dark': svg(2732, pond(2732, false) + lotus(2732, 0.2)),
};

fs.mkdirSync('assets', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, markup] of Object.entries(sources)) {
  const size = Number(/width="(\d+)"/.exec(markup)[1]);
  fs.writeFileSync(`assets/${name}.svg`, markup);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0">${markup}</body></html>`);
  await page.screenshot({ path: `assets/${name}.png`, clip: { x: 0, y: 0, width: size, height: size } });
}
await browser.close();

execSync(`npx -y @capacitor/assets@4.0.0 generate --android --ios --iconBackgroundColor '${POND}' --iconBackgroundColorDark '${POND}' --splashBackgroundColor '${POND}' --splashBackgroundColorDark '${POND}'`, { stdio: 'inherit' });

const res = 'android/app/src/main/res';
for (const dir of fs.readdirSync(res).filter(d => d.startsWith('mipmap-'))) {
  for (const f of ['ic_launcher_foreground.png', 'ic_launcher_background.png']) fs.rmSync(path.join(res, dir, f), { force: true });
}
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <!-- Android 13+ themed icons use the lotus silhouette. -->
    <monochrome android:drawable="@drawable/ic_launcher_foreground" />
</adaptive-icon>
`;
for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) fs.writeFileSync(path.join(res, 'mipmap-anydpi-v26', f), adaptive);

// Launch images the asset catalogue no longer lists.
const splashSet = 'ios/App/App/Assets.xcassets/Splash.imageset';
const listed = new Set(JSON.parse(fs.readFileSync(`${splashSet}/Contents.json`, 'utf8')).images.map(i => i.filename));
for (const f of fs.readdirSync(splashSet)) if (f.endsWith('.png') && !listed.has(f)) fs.rmSync(path.join(splashSet, f));
console.log('mobile assets ready');
