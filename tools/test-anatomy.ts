// Checks that the anatomy models, their rigs (src/anatomy/bodies/*.json), the organ text (src/anatomy/organs.ts) and the
// pre-rendered body maps agree, and that the body follows the profile. Run: npm run test:anatomy
// After rebuilding a model (tools/anatomy/build.mjs), render its body map again (tools/render-bodymap.mjs).
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeIO, type Document } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { ORGAN_IDS } from '../shared/constants.ts';
import { ORGANS, ORGAN_BY_ID, PICKABLE, TISSUE } from '../src/anatomy/organs.ts';
import { RIGS, focusOf, landmarksOf, meshSpecs, organsIn, pinOf } from '../src/anatomy/bodies.ts';
import { BODIES, DEFAULT_BODY, bodyFor, type Body } from '../src/lib/body.ts';
import type { OrganId } from '../src/types.ts';

const root = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const modelFile = (body: Body) => root(`public/models/anatomy-${body}.glb`);

/** Landmarks only one body has. */
const ONLY: Record<Body, string[]> = {
  female: ['Uterus', 'Cervix', 'Ovaries', 'Fallopian tubes', 'Vagina'],
  male: ['Prostate', 'Seminal vesicles', 'Vas deferens', 'Testes'],
};
/** Organs a body does not have at all. */
const ABSENT: Record<Body, OrganId[]> = { female: [], male: ['breast'] };

const docs = new Map<Body, Document>();
before(async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  for (const body of BODIES) docs.set(body, await io.read(modelFile(body)));
});

for (const body of BODIES) {
  describe(`${body} body`, () => {
    const rig = RIGS[body];

    it('has a model node for every rig part, and no others', () => {
      const nodes = docs.get(body)!.getRoot().listNodes().filter(n => n.getMesh());
      const names = nodes.map(n => n.getName()).sort();
      assert.deepEqual(names, Object.keys(rig.parts).sort());
      for (const n of nodes) {
        const extras = n.getExtras() as { organ?: string; tissue?: string };
        assert.equal(extras.organ, rig.parts[n.getName()].organ, `${n.getName()}: organ in the model and in the rig`);
        assert.equal(extras.tissue, rig.parts[n.getName()].tissue, `${n.getName()}: tissue in the model and in the rig`);
      }
    });

    it('carries the licence in the model file', () => {
      const asset = docs.get(body)!.getRoot().getAsset();
      assert.match(asset.copyright ?? '', /CC BY-SA 4\.0/);
      assert.match(asset.copyright ?? '', /HuBMAP/);
      assert.match(asset.copyright ?? '', /Z-Anatomy/);
    });

    it('maps every part to a known organ and tissue', () => {
      for (const [id, p] of Object.entries(rig.parts)) {
        assert.ok((ORGAN_IDS as readonly string[]).includes(p.organ), `${id}: organ ${p.organ}`);
        assert.ok(p.tissue in TISSUE, `${id}: tissue ${p.tissue}`);
      }
      assert.equal(meshSpecs(body).size, Object.keys(rig.parts).length);
    });

    it('is built from every catalogued part', () => {
      const missing = (rig as unknown as { missing?: string[] }).missing ?? [];
      const expected = body === 'male' ? ['breasts'] : [];
      assert.deepEqual(missing.filter(m => !expected.includes(m)), [], 'parts with no geometry');
    });

    it('stands on the floor, centred, at an adult height', () => {
      const [lo, hi] = rig.bounds;
      assert.ok(Math.abs(lo[1]) < 0.005, `soles at y=0 (${lo[1]})`);
      assert.ok(Math.abs(lo[0] + hi[0]) < 0.02 && Math.abs(lo[2] + hi[2]) < 0.05, 'centred on x and z');
      assert.ok(rig.height > 1.5 && rig.height < 2, `height ${rig.height}`);
    });

    it('has every organ but the ones it lacks', () => {
      const missing = ORGANS.map(o => o.id).filter(id => !organsIn(body).has(id));
      assert.deepEqual(missing, ABSENT[body]);
    });

    it('has the parts each organ focuses on', () => {
      for (const o of ORGANS) {
        if (ABSENT[body].includes(o.id)) continue;
        const ids = focusOf(body, o.id);
        assert.ok(ids.length > 0, `${o.id}: nothing to focus on`);
        for (const id of ids) assert.ok(id in rig.parts, `${o.id}: focus part ${id} is not in the model`);
      }
    });

    it('has a pin inside the body for every organ you can pick', () => {
      const [lo, hi] = rig.bounds;
      for (const id of PICKABLE) {
        if (ABSENT[body].includes(id)) { assert.equal(pinOf(body, id), null, `${id}: pin for an organ this body lacks`); continue; }
        const pin = pinOf(body, id);
        assert.ok(pin, `${id}: no pin`);
        for (let k = 0; k < 3; k++) assert.ok(pin[k] >= lo[k] - 0.05 && pin[k] <= hi[k] + 0.05, `${id}: pin outside the body`);
      }
    });

    it('places every landmark that has a note, and has a note for every landmark', () => {
      for (const o of ORGANS) {
        if (ABSENT[body].includes(o.id)) continue;
        const placed = (rig.landmarks[o.id as OrganId] ?? []).map(l => l.name);
        const noted = new Set(o.landmarks.map(l => l.name));
        for (const name of placed) assert.ok(noted.has(name), `${o.id}: landmark ${name} has no note`);
        const other = ONLY[body === 'male' ? 'female' : 'male'];
        for (const name of placed) assert.ok(!other.includes(name), `${o.id}: ${name} belongs to the other body`);
        const expected = o.landmarks.map(l => l.name).filter(n => !other.includes(n));
        assert.deepEqual(expected.filter(n => !placed.includes(n)), [], `${o.id}: notes with no landmark`);
        assert.equal(landmarksOf(body, o.id).length, placed.length);
      }
    });

    it('has a body map rendered from this model', () => {
      const m = JSON.parse(fs.readFileSync(root(`src/components/bodymap2d/manifest.${body}.json`), 'utf8'));
      assert.equal(m.body, body);
      assert.ok(m.angles.length >= 8, 'body map angles');
      const sha = crypto.createHash('sha256').update(fs.readFileSync(modelFile(body))).digest('hex');
      assert.ok(sha.startsWith(m.model.sha), 'the body map was rendered from an older model: run node tools/render-bodymap.mjs');
      assert.equal(m.model.path, `models/anatomy-${body}.glb`);
      const files = new Set(fs.readdirSync(root('public/bodymap')));
      const prefix = body === 'female' ? 'f-' : 'm-';
      for (const a of m.angles) for (const f of [a.image['1x'], a.image['2x'], a.id]) {
        assert.ok(f.startsWith(prefix), `${f}: body prefix`);
        assert.ok(files.has(f), `${f}: missing from public/bodymap`);
      }
      for (const a of m.angles) for (const id of Object.keys(a.pins)) assert.ok(ORGAN_BY_ID[id as OrganId], `pin for unknown organ ${id}`);
    });
  });
}

describe('website pictures', () => {
  it('show the current female body', () => {
    const file = root('public/site/shots.json');
    assert.ok(fs.existsSync(file), 'no public/site/shots.json: run node tools/site/shots.mjs with the dev stack');
    const shots = JSON.parse(fs.readFileSync(file, 'utf8'));
    const sha = crypto.createHash('sha256').update(fs.readFileSync(modelFile('female'))).digest('hex');
    assert.ok(sha.startsWith(shots.model.sha), 'the site pictures show an older model: run node tools/site/shots.mjs with the dev stack');
  });
});

describe('which body the map shows', () => {
  it('follows the profile sex unless a body was chosen', () => {
    assert.equal(bodyFor('female'), 'female');
    assert.equal(bodyFor('male'), 'male');
    assert.equal(bodyFor('intersex'), DEFAULT_BODY);
    assert.equal(bodyFor(null), DEFAULT_BODY);
    assert.equal(bodyFor('male', 'female'), 'female');
    assert.equal(bodyFor('female', 'male'), 'male');
    assert.equal(bodyFor('intersex', 'male'), 'male');
    assert.equal(bodyFor('male', 'profile'), 'male');
  });

  it('remembers a chosen body per profile on this device, and ignores bad stored values', async () => {
    const store = new Map<string, string>([['lotuspond.stage', JSON.stringify({ mode: '3d', bodies: { a: 'male', b: 'robot', c: 'female' } })]]);
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); },
    };
    const { useStage } = await import('../src/components/stage/stageSettings.ts');
    assert.deepEqual(useStage.getState().bodies, { a: 'male', c: 'female' });
    assert.equal(useStage.getState().mode, '3d');
    useStage.getState().setBody('b', 'female');
    useStage.getState().setBody('a', 'profile');
    assert.deepEqual(JSON.parse(store.get('lotuspond.stage')!).bodies, { b: 'female', c: 'female' });
  });
});
