// Encryption at rest, key rotation, and the configuration and secrets that production refuses to start without.
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DiskFileStore } from '../src/lib/files.ts';
import { decryptFile, EncryptedFileStore, FileIntegrityError, HEADER_BYTES } from '../src/lib/files-encrypted.ts';
import { loadConfig } from '../src/config.ts';
import { resolveSecrets } from '../src/compliance/secrets.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lotuspond-enc-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const PID = '11111111-1111-4111-8111-111111111111';
const DID = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const KEY = `${PID}/${DID}`;

let dirs = 0;
function store(ring = { current: randomBytes(32), previous: [] as Buffer[] }) {
  const disk = new DiskFileStore(path.join(tmp, String(++dirs)));
  return { disk, ring, enc: new EncryptedFileStore(disk, ring) };
}

async function readAll(s: ReadableStream<Uint8Array> | null): Promise<Buffer> {
  assert.ok(s);
  return Buffer.from(await new Response(s).arrayBuffer());
}

const plain = Buffer.from('%PDF-1.7 LDL 138 mg/dL, HbA1c 9.7% — Asha Rao');

describe('encrypted file store', () => {
  it('round-trips a file and keeps no plaintext on disk', async () => {
    const { disk, enc } = store();
    await enc.put(KEY, plain);
    const raw = Buffer.from((await disk.read(KEY))!);
    assert.equal(raw.subarray(0, 4).toString('latin1'), 'LPEF');
    assert.equal(raw[4], 1, 'format version');
    assert.equal(raw.length, HEADER_BYTES + plain.length, 'GCM adds only the header');
    assert.equal(raw.includes(Buffer.from('LDL 138')), false);
    assert.deepEqual(await readAll(await enc.get(KEY)), plain);
    assert.equal(await enc.get(`${PID}/${OTHER}`), null, 'missing files are null');
  });

  it('uses a fresh IV for every file', async () => {
    const { disk, enc } = store();
    await enc.put(KEY, plain);
    await enc.put(`${PID}/${OTHER}`, plain);
    const a = Buffer.from((await disk.read(KEY))!), b = Buffer.from((await disk.read(`${PID}/${OTHER}`))!);
    assert.notDeepEqual(a.subarray(9, 21), b.subarray(9, 21));
    assert.notDeepEqual(a.subarray(HEADER_BYTES), b.subarray(HEADER_BYTES));
  });

  it('refuses tampered, truncated, moved and foreign files', async () => {
    const { disk, enc, ring } = store();
    await enc.put(KEY, plain);
    const good = Buffer.from((await disk.read(KEY))!);
    const flip = (i: number) => { const b = Buffer.from(good); b[i] ^= 0x01; return b; };
    const cases: [string, Buffer][] = [
      ['ciphertext byte', flip(HEADER_BYTES + 5)],
      ['last byte', flip(good.length - 1)],
      ['iv', flip(12)],
      ['tag', flip(30)],
      ['version', flip(4)],
      ['key id', flip(6)],
      ['magic', flip(0)],
      ['truncated', good.subarray(0, good.length - 1)],
      ['header only', good.subarray(0, HEADER_BYTES)],
      ['plaintext', plain],
    ];
    for (const [what, bytes] of cases) {
      await disk.put(KEY, bytes);
      await assert.rejects(enc.get(KEY), FileIntegrityError, what);
    }
    // The storage key is authenticated: the same bytes under another profile's path do not decrypt.
    await disk.put(`${OTHER}/${DID}`, good);
    await assert.rejects(enc.get(`${OTHER}/${DID}`), FileIntegrityError, 'moved file');
    // Another server's key.
    assert.throws(() => decryptFile(KEY, good, { current: randomBytes(32), previous: [] }), /could not be read/);
    assert.deepEqual(decryptFile(KEY, good, ring), plain);
  });

  it('rotates keys: old files stay readable, then re-encrypt to the new key', async () => {
    const oldKey = randomBytes(32), newKey = randomBytes(32);
    const { disk, enc: before } = store({ current: oldKey, previous: [] });
    await before.put(KEY, plain);
    await disk.put(`${PID}/${OTHER}`, plain); // from before encryption was turned on

    const rotating = new EncryptedFileStore(disk, { current: newKey, previous: [oldKey] });
    assert.deepEqual(await readAll(await rotating.get(KEY)), plain, 'previous key still reads');
    await assert.rejects(rotating.get(`${PID}/${OTHER}`), FileIntegrityError, 'plaintext is not served');

    const report = await rotating.rekey();
    assert.deepEqual({ ...report, failed: report.failed.length }, { checked: 2, encrypted: 1, rekeyed: 1, failed: 0 });
    const after = new EncryptedFileStore(disk, { current: newKey, previous: [] });
    assert.deepEqual(await readAll(await after.get(KEY)), plain);
    assert.deepEqual(await readAll(await after.get(`${PID}/${OTHER}`)), plain);
    const again = await after.rekey();
    assert.equal(again.encrypted + again.rekeyed, 0, 'running it again changes nothing');
  });
});

describe('configuration and secrets', () => {
  const quiet = () => {};
  const key = () => randomBytes(32).toString('base64');

  it('refuses to start in production without the directory secret and a file key', () => {
    const prod = { NODE_ENV: 'production', DATA_DIR: path.join(tmp, 'prod') };
    assert.throws(() => resolveSecrets(loadConfig(prod), { warn: quiet }), /DIRECTORY_SECRET is required in production/);
    const withDir = { ...prod, DIRECTORY_SECRET: key() };
    assert.throws(() => resolveSecrets(loadConfig(withDir), { warn: quiet }), /FILE_ENCRYPTION_KEY is required in production/);
    const ok = resolveSecrets(loadConfig({ ...withDir, FILE_ENCRYPTION_KEY: key() }), { warn: quiet });
    assert.equal(ok.fileKeys?.default?.current.length, 32);
    const off = resolveSecrets(loadConfig({ ...withDir, FILE_ENCRYPTION: 'off' }), { warn: quiet });
    assert.equal(off.fileKeys, null, 'encryption can be turned off, explicitly');
    assert.ok(!fs.existsSync(prod.DATA_DIR), 'production never writes secrets to disk');
  });

  it('generates development secrets once, in DATA_DIR, with a warning', () => {
    const dataDir = path.join(tmp, 'dev');
    const warnings: string[] = [];
    const first = resolveSecrets(loadConfig({ NODE_ENV: 'development', DATA_DIR: dataDir }), { warn: m => warnings.push(m) });
    assert.ok(warnings.some(w => w.includes('DIRECTORY_SECRET')) && warnings.some(w => w.includes('FILE_ENCRYPTION_KEY')));
    assert.ok(fs.existsSync(path.join(dataDir, 'secrets', 'directory-secret')));
    const second = resolveSecrets(loadConfig({ NODE_ENV: 'development', DATA_DIR: dataDir }), { warn: quiet });
    assert.deepEqual(second.directoryKey, first.directoryKey, 'same secret on the next start');
    assert.deepEqual(second.fileKeys?.default?.current, first.fileKeys?.default?.current);
    assert.notDeepEqual(first.directoryKey, first.auditKey, 'separate keys for the directory and the audit log');
    const local = resolveSecrets(loadConfig({ NODE_ENV: 'production', LOCAL_SECRETS: 'true', DATA_DIR: dataDir }), { warn: quiet });
    assert.deepEqual(local.directoryKey, first.directoryKey, 'npm run local reuses them');
  });

  it('gives a cell with its own storage its own key, still reading the shared one', () => {
    const shared = key(), india = key();
    const s = resolveSecrets(loadConfig({
      NODE_ENV: 'production', DIRECTORY_SECRET: key(), FILE_ENCRYPTION_KEY: shared,
      SERVED_REGIONS: 'in,global', CELL_IN_DATABASE_URL: 'postgres://u:p@db-in:5432/lp', CELL_IN_FILE_ENCRYPTION_KEY: india,
    }), { warn: quiet });
    assert.equal(s.fileKeys?.in?.current.toString('base64'), india);
    assert.equal(s.fileKeys?.in?.previous[0].toString('base64'), shared);
    assert.equal(s.fileKeys?.default?.current.toString('base64'), shared);
  });

  it('parses served regions and rejects settings that would mix cells', () => {
    assert.deepEqual(loadConfig({}).servedRegions, ['in', 'eu', 'us', 'global']);
    assert.deepEqual(loadConfig({ SERVED_REGIONS: 'in, eu' }).servedRegions, ['in', 'eu']);
    assert.throws(() => loadConfig({ SERVED_REGIONS: 'in,mars' }), /unknown region mars/);
    assert.deepEqual(loadConfig({}).openCountries, ['IN'], 'Health opens in India first');
    assert.deepEqual(loadConfig({ OPEN_COUNTRIES: 'in, de' }).openCountries, ['IN', 'DE']);
    const all = loadConfig({ OPEN_COUNTRIES: 'all' }).openCountries;
    assert.ok(all.includes('FR') && !all.includes('AE'), 'all leaves out legally restricted countries');
    assert.throws(() => loadConfig({ OPEN_COUNTRIES: 'IN,ZZ' }), /unknown country ZZ/);
    assert.throws(() => loadConfig({ OPEN_COUNTRIES: 'AE' }), /AE cannot open/);
    const url = 'postgres://u:p@db:5432/lp';
    assert.throws(() => loadConfig({ DATABASE_URL: url, CELL_IN_DATABASE_URL: url }), /same database as DATABASE_URL/);
    assert.throws(() => loadConfig({ CELL_IN_DATABASE_URL: url, CELL_EU_DATABASE_URL: url }), /same database/);
    assert.throws(() => loadConfig({ CELL_IN_FILE_ENCRYPTION_KEY: key() }), /no database or data directory of its own/);
    assert.throws(() => loadConfig({ FILE_ENCRYPTION_KEY: 'too-short' }), /32 random bytes/);
    const cells = loadConfig({ SERVED_REGIONS: 'in,global', CELL_IN_DATA_DIR: '/srv/in' }).cells;
    assert.deepEqual(cells.map(c => [c.region, c.dataDir ?? null]), [['in', '/srv/in'], ['global', null]]);
  });
});
