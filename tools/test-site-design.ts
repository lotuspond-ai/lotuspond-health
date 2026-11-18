// The landing page's design tokens (src/site/home.css) against the LotusPond design system
// (a copy of design-system/project/tokens.json from lotuspond-ai/lotuspond, kept in src/site/lotuspond-tokens.json)
// and WCAG 2.2 AA. A colour changed in one place and not the other, or a text,
// control or tomato pair that drops below its contrast floor, fails here instead of in an audit.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const css = readFileSync(new URL('src/site/home.css', root), 'utf8');
const system = JSON.parse(readFileSync(new URL('src/site/lotuspond-tokens.json', root), 'utf8')) as {
  color: { tokens: { name: string; value: { light: string; dark: string } }[] };
};

const start = css.indexOf('.home {');
assert.notEqual(start, -1, 'the .home token block is declared');
const block = css.slice(start, css.indexOf('}', start));
const raw = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
/** A page token's hex value, following var() references inside the block. */
function page(name: string, depth = 0): string {
  const value = raw[name];
  assert.ok(value, `--${name} is declared on .home`);
  assert.ok(depth < 8, `--${name} resolves without a cycle`);
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  return ref ? page(ref[1], depth + 1) : value.toLowerCase();
}

const light = new Map(system.color.tokens.map(t => [t.name, t.value.light]));
function token(name: string, depth = 0): string {
  const value = light.get(name);
  assert.ok(value, `${name} is a design system colour`);
  assert.ok(depth < 8, `${name} resolves without a cycle`);
  return value.startsWith('{') ? token(value.slice(1, -1), depth + 1) : value.toLowerCase();
}

// WCAG 2.2 relative luminance and contrast ratio.
function luminance(hex: string): number {
  const channel = (offset: number) => {
    const v = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
function atLeast(floor: number, pairs: [string, string, string][]) {
  for (const [label, fg, bg] of pairs) {
    const ratio = contrast(page(fg), page(bg));
    assert.ok(ratio >= floor, `${label}: ${ratio.toFixed(2)} is below ${floor}:1`);
  }
}

test('every page colour token equals the design system token of the same name', () => {
  const names = Object.keys(raw).filter(n => /^#|^var\(/.test(raw[n]) && light.has(n));
  assert.ok(names.length >= 25, `most page colours are design system tokens (${names.length} found)`);
  for (const name of names) assert.equal(page(name), token(name), `--${name} should equal ${name} in tokens.json`);
});

test('text meets 4.5:1 on the field, the sheets, the cards and the pine chapter', () => {
  atLeast(4.5, [
    ['ink on the sage field', 'on-field', 'field'],
    ['muted text on the sage field', 'on-field-muted', 'field'],
    ['ink on a sheet', 'ink', 'surface'],
    ['muted text on a sheet', 'ink-muted', 'surface'],
    ['muted text on a tinted card', 'ink-muted', 'surface-tint'],
    ['muted text on a raised card', 'ink-muted', 'surface-raised'],
    ['step numbers and partner labels on a sheet', 'sage-700', 'surface'],
    ['partner label on a raised card', 'sage-700', 'surface-raised'],
    ['ink on a chip', 'pine-900', 'off-white'],
    ['ink button label', 'off-white', 'pine-900'],
    ['light button label', 'pine-900', 'off-white'],
    ['accent button label', 'on-accent', 'accent'],
    ['accent button label on hover', 'on-accent', 'accent-hover'],
    ['text on the pine chapter', 'on-deep', 'deep'],
    ['muted text on the pine chapter', 'on-deep-muted', 'deep'],
    ['region card text', 'on-deep-muted', 'deep-raised'],
  ]);
});

test('the focus ring and control edges meet 3:1 wherever they are drawn', () => {
  atLeast(3, [
    ['focus on the sage field', 'focus', 'field'],
    ['focus on a sheet', 'focus', 'surface'],
    ['focus on a tinted card', 'focus', 'surface-tint'],
    ['focus on the pine chapter', 'on-deep', 'deep'],
    ['region code edge on its card', 'on-deep-muted', 'deep-raised'],
  ]);
});

test('tomato never sits on the sage field, and holds 3:1 where the page marks with it', () => {
  assert.ok(contrast(page('tomato-500'), page('field')) < 3, 'tomato would read on sage');
  assert.ok(contrast(page('accent'), page('field')) < 3, 'the accent button would read on sage');
  atLeast(3, [
    ['underline on a sheet', 'accent-mark', 'surface'],
    ['underline on the pine chapter', 'accent-mark', 'deep'],
    ['accent button on a sheet', 'accent', 'surface'],
  ]);
});

// The signed-in app (src/index.css) keeps its own variable names; each one is held to the design system role it draws.
const appCss = readFileSync(new URL('src/index.css', root), 'utf8');
const appRoot = appCss.slice(appCss.indexOf(':root {'), appCss.indexOf('}', appCss.indexOf(':root {')));
const app = Object.fromEntries([...appRoot.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim().toLowerCase()]));
const APP_ROLES: Record<string, string> = {
  mist: 'surface-tint', 'mist-2': 'sage-200', paper: 'surface-raised', well: 'surface', ink: 'ink', reed: 'ink-muted', line: 'line',
  'line-strong': 'line-strong', pond: 'deep', 'pond-2': 'pine-800', 'on-deep': 'on-deep', 'on-deep-muted': 'on-deep-muted', lily: 'brand-text',
  'lily-soft': 'positive-tint', positive: 'positive', 'lotus-deep': 'sage-700', accent: 'accent', 'accent-hover': 'accent-hover',
  'accent-tint': 'accent-tint', 'accent-mark': 'accent-mark',
};

test('the app\'s colours are the design system\'s roles', () => {
  for (const [name, role] of Object.entries(APP_ROLES)) assert.equal(app[name], token(role), `--${name} in src/index.css should be ${role}`);
});

test('the app reads in the brand faces, never the faces it replaced', () => {
  assert.match(app.serif, /^'platypi variable'/, 'display face');
  assert.match(app.sans, /^'atkinson hyperlegible next variable'/, 'sans face');
  for (const old of ['Newsreader', 'Hanken Grotesk']) assert.ok(!appCss.includes(old), `${old} is gone from src/index.css`);
  const shell = readFileSync(new URL('app.html', root), 'utf8');
  assert.ok(!shell.includes('fonts.css'), 'app.html no longer loads the old fonts');
});

test('in the app, the main action is the brand button and tomato is kept for decisions', () => {
  assert.match(appCss, /\.btn--primary \{ background: var\(--lily\);/, 'main action is sage-700');
  assert.match(appCss, /\.btn--decide \{ background: var\(--accent\);/, 'tomato fills only the decide button');
});
