// Health pictures in the LotusPond "one thread" style (design-system/project/README.md, Illustration), drawn from the
// same shapes as the approved set in design-system/project/assets/Illustrations: the thread, seeds, the bloom on an
// off-white disc, the hand, and Health's things (a record folder, a pulse card, a pill bottle, a capsule, a vial and
// a lab report). Writes them to src/site/illustrations/:
//
//   node tools/site/illustrations.mjs
//
// - health-journey.svg (1200×300, sage-500): the closing strip. Health's version of the-journey: the same tangle,
//   thread and bloom in a hand, with Health's things in the tangle instead of a truck and a parcel.
// - records-in-hand.svg (480×360, pine-900): Health's version of in-your-hands, for the privacy chapter: a hand
//   holding a record folder, the thread rising from it to the bloom. Your records, in your hands.
// - records-into-one.svg (480×360, sage-500): Health's version of many-into-one, for a band on the field: files
//   from several places joining one thread that ends in the bloom.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const set = path.join(root, 'design-system/project/assets/Illustrations');
const out = path.join(root, 'src/site/illustrations');

const C = { sage500: '#9CAF88', sage300: '#B9C7A9', sage200: '#D5DFCA', sage700: '#55694A', pine: '#18211B', paper: '#F7F5EF', tomato: '#E8412C' };

const at = (x, y, rot, s, body) => `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${s} ${s})">${body}</g>`;
const thread = (d, colour = C.pine) =>
  `<path d="${d}" fill="none" stroke="${colour}" stroke-opacity="1" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
const seed = (x, y, r = 5.5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="${C.paper}"/>`;

// Health's things, as drawn in where-records-live.svg, coloured for a sage ground: off-white leads, sage-700 is the
// second tone, and pine marks the details.
// On pine the folder's front turns sage-300 and its paper off-white, as in where-records-live.svg; on a sage-700
// disc its back turns pine so the folder keeps its shape.
const folder = ({ front = C.paper, sheet = C.sage200, back = C.sage700 } = {}) =>
  `<rect x="-46" y="-40" width="40" height="20" rx="6" fill="${back}"/><rect x="-46" y="-30" width="92" height="62" rx="8" fill="${back}"/>` +
  `<rect x="-36" y="-36" width="72" height="30" rx="5" fill="${sheet}"/><rect x="-46" y="-14" width="92" height="46" rx="8" fill="${front}"/>` +
  `<path d="M-8 9H8M0 1V17" stroke="${C.pine}" stroke-width="4" stroke-linecap="round"/>`;
const pulseCard = () =>
  `<rect x="-50" y="-32" width="100" height="64" rx="9" fill="${C.paper}"/>` +
  `<path d="M-36 4h16l7 -20l9 36l8 -24l5 8h27" fill="none" stroke="${C.pine}" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/>`;
const pillBottle = () =>
  `<rect x="-24" y="-22" width="48" height="58" rx="9" fill="${C.paper}"/><rect x="-24" y="-4" width="48" height="22" fill="${C.sage300}"/>` +
  `<rect x="-28" y="-38" width="56" height="18" rx="6" fill="${C.sage700}"/>`;
const capsule = () =>
  `<rect x="-22" y="-10" width="44" height="20" rx="10" fill="${C.paper}"/><path d="M0 -10H12a10 10 0 0 1 0 20H0Z" fill="${C.sage700}"/>`;
const vial = () =>
  `<rect x="-13" y="-36" width="26" height="70" rx="13" fill="${C.paper}"/><path d="M-13 2H13V21a13 13 0 0 1 -26 0Z" fill="${C.sage700}"/>` +
  `<rect x="-17" y="-44" width="34" height="13" rx="5" fill="${C.pine}"/>`;
const report = () => {
  const line = (y, w) => `<path d="M-15.0 ${y}h${w}" stroke="${C.pine}" stroke-opacity=".32" stroke-width="3" stroke-linecap="round"/>`;
  return `<rect x="-30.0" y="-38.0" width="60" height="76" rx="8" fill="${C.paper}"/>${line(-16, 30)}${line(-1, 30)}${line(14, 12)}`;
};

// The bloom: five tomato petals on an off-white disc; where the thread crosses the disc it is pine.
function bloom(x, stemTop, disc, r, scale) {
  const petal = 'M0 0C-32 -28 -32 -76 0 -114c32 38 32 86 0 114Z';
  const petals = [[-70, 0.76], [70, 0.76], [-36, 0.92], [36, 0.92], [0, 1]]
    .map(([rot, s]) => `<path d="${petal}" transform="rotate(${rot}) scale(${s})"/>`).join('');
  const base = Math.round(disc + r * 0.52);
  return `<circle cx="${x}" cy="${disc}" r="${r}" fill="${C.paper}"/>` +
    `<path d="M${x} ${base}v${(stemTop - base).toFixed(1)}" fill="none" stroke="${C.pine}" stroke-width="3"/>` +
    `<g transform="translate(${x} ${base}) scale(${scale})" fill="${C.tomato}" stroke="${C.paper}" stroke-width="${(3 / scale).toFixed(2)}" stroke-linejoin="round">${petals}</g>`;
}

// An open palm with a sage-700 cuff, as in the-journey.svg.
const hand = () =>
  `<rect x="-130" y="-21" width="134" height="44" rx="8" fill="${C.sage700}"/>` +
  `<path d="M0 -15C20 -17 34 -13 46 -11L98 -7C109 -6 110 5 100 7L60 13C40 21 18 21 0 17Z" fill="${C.paper}"/>` +
  `<path d="M12 -14C8 -31 20 -42 31 -38C38 -35 37 -25 30 -12Z" fill="${C.paper}"/>`;

const svg = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">\n<rect width="${w}" height="${h}" fill="${C.sage500}"/>\n${body.join('\n')}\n</svg>\n`;

// The closing strip. The tangle is the approved one from the-journey.svg, so both strips are drawn by one hand.
const journey = fs.readFileSync(path.join(set, 'the-journey.svg'), 'utf8');
const tangle = journey.split('\n').find(l => l.startsWith('<path d="M299.3'));
if (!tangle) throw new Error('the tangle in the-journey.svg was not found');

const healthJourney = svg(1200, 300, [
  tangle,
  at(98, 222, -6, 0.86, pulseCard()),
  at(292, 122, 8, 1.0, report()),
  at(236, 232, -14, 0.8, vial()),
  at(170, 104, -8, 0.86, folder()),
  at(58, 120, -24, 0.9, capsule()),
  `<circle cx="1080" cy="150" r="124" fill="${C.sage300}"/>`,
  at(1204, 240, 0, 1.6, hand()).replace('scale(1.6 1.6)', 'scale(-1.6 1.6)'),
  thread('M330 184C420 230 470 150 560 190S760 234 880 196S1020 160 1084 222'),
  seed(470, 184), seed(652, 207), seed(800, 215), seed(940, 181),
  thread('M1084 222V112'),
  `<circle cx="1084" cy="222" r="5" fill="${C.pine}"/>`,
  bloom(1084, 141.6, 84, 57.6, 0.6),
]);

// Many into one, for Health: four threads from the things a record is made of, joining at one knot under the bloom.
const recordsIntoOne = svg(480, 360, [
  thread('M240 232C200 262 122 190 112 150'),
  thread('M240 232C190 272 178 252 118 262'),
  thread('M240 232C280 262 362 186 372 140'),
  thread('M240 232C290 276 306 268 366 268'),
  at(108, 108, -5, 1.0, folder()),
  at(110, 290, 4, 1.0, pulseCard()),
  at(370, 100, 6, 1.0, pillBottle()),
  at(424, 150, -28, 0.9, capsule()),
  at(372, 278, 10, 1.0, report()),
  thread('M240 232V132'),
  `<circle cx="240" cy="232" r="6" fill="${C.pine}"/>`,
  bloom(240, 162.5, 103, 59.5, 0.62),
]);

// In your hands, for Health: the record rests on an open palm and the thread rises from it to the bloom. On pine the
// thread is off-white, and pine again where it crosses the disc.
const recordsInHand = svg(480, 360, [
  `<circle cx="262" cy="168" r="126" fill="${C.sage700}"/>`,
  at(150, 268, -4, 1.5, hand()),
  at(262, 212, -4, 1.25, folder({ front: C.sage300, sheet: C.paper, back: C.pine })),
  thread('M262 166V108', C.paper),
  `<circle cx="262" cy="166" r="5" fill="${C.paper}"/>`,
  bloom(262, 133, 85, 48, 0.5),
]).replace(`fill="${C.sage500}"/>`, `fill="${C.pine}"/>`);

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'health-journey.svg'), healthJourney);
fs.writeFileSync(path.join(out, 'records-into-one.svg'), recordsIntoOne);
fs.writeFileSync(path.join(out, 'records-in-hand.svg'), recordsInHand);
console.log('wrote health-journey.svg, records-into-one.svg and records-in-hand.svg');
