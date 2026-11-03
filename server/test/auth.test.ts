// Phone OTP sign-in and sessions, through the HTTP API. Run: npm run test:server
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { apiEnv, HOUR } from './helpers.ts';

const PHONE = '+919812345678';

describe('sign-in', () => {
  test('a code by SMS signs you in; the token works until you sign out', async () => {
    const env = apiEnv();
    const sent = await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.sent, true);
    const code = env.codes.get(PHONE)!;
    assert.match(code, /^\d{6}$/);

    const wrong = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code: code === '000000' ? '111111' : '000000' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'invalid_code');
    assert.match(wrong.body.message, /4 tries left/);

    const ok = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code } });
    assert.equal(ok.status, 200);
    assert.match(ok.body.token, /^lps_/);
    assert.equal(ok.body.newUser, true);
    const token = ok.body.token as string;

    assert.equal((await env.call('GET', '/v1/orders', { token })).status, 200);
    const anon = await env.call('GET', '/v1/orders');
    assert.equal(anon.status, 401);
    assert.equal(anon.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await env.call('GET', '/v1/orders', { token: 'lps_not-a-real-token' })).status, 401);

    assert.equal((await env.call('POST', '/v1/auth/logout', { token })).status, 204);
    assert.equal((await env.call('GET', '/v1/orders', { token })).status, 401);
  });

  test('a code works once, and expires after 5 minutes', async () => {
    const env = apiEnv();
    await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    const code = env.codes.get(PHONE)!;
    assert.equal((await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code } })).status, 200);
    const again = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code } });
    assert.equal(again.body.error, 'invalid_code');

    await env.advance(30_000);
    await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    await env.advance(5 * 60_000 + 1);
    const late = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code: env.codes.get(PHONE) } });
    assert.equal(late.status, 401);
    assert.equal(late.body.error, 'code_expired');
  });

  test('five wrong codes lock the code, even the right one afterwards', async () => {
    const env = apiEnv();
    await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    const code = env.codes.get(PHONE)!;
    const bad = code === '123456' ? '654321' : '123456';
    const replies = [];
    for (let i = 0; i < 5; i++) replies.push(await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code: bad } }));
    assert.deepEqual(replies.map(r => r.status), [401, 401, 401, 401, 429]);
    assert.equal(replies[4].body.error, 'too_many_attempts');
    const right = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code } });
    assert.equal(right.status, 429);
    assert.equal(right.body.error, 'too_many_attempts');
  });

  test('codes are at least 30 s apart and at most 5 an hour per number', async () => {
    const env = apiEnv();
    assert.equal((await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } })).status, 202);
    const soon = await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    assert.equal(soon.status, 429);
    assert.equal(soon.body.error, 'too_soon');
    assert.equal(soon.headers.get('retry-after'), '30');
    for (let i = 0; i < 4; i++) {
      await env.advance(31_000);
      assert.equal((await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } })).status, 202, `send ${i + 2}`);
    }
    await env.advance(31_000);
    const sixth = await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.body.error, 'too_many_codes');
    await env.advance(HOUR);
    assert.equal((await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } })).status, 202);
  });

  test('per-address limit across numbers', async () => {
    const env = apiEnv({ otpPerIp: 3 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await env.call('POST', '/v1/auth/otp', { body: { phone: `+91981234567${i}` } })).status);
    assert.deepEqual(statuses, [202, 202, 202, 429]);
    const other = await env.call('POST', '/v1/auth/otp', { body: { phone: '+919812345679' }, headers: { 'x-test-ip': '10.1.1.1' } });
    assert.equal(other.status, 202);
  });

  test('only Indian mobile numbers in E.164', async () => {
    const env = apiEnv();
    for (const phone of ['9812345678', '+14155550100', '+915812345678', '+91981234567']) {
      const r = await env.call('POST', '/v1/auth/otp', { body: { phone } });
      assert.equal(r.status, 400, phone);
      assert.equal(r.body.error, 'invalid_phone');
    }
    assert.equal((await env.call('POST', '/v1/auth/otp', { body: {} })).status, 400);
  });

  test('signing in again finds the same account; sessions expire after 30 days', async () => {
    const env = apiEnv();
    const first = await env.signIn(PHONE);
    await env.advance(31_000);
    await env.call('POST', '/v1/auth/otp', { body: { phone: PHONE } });
    const v = await env.call('POST', '/v1/auth/verify', { body: { phone: PHONE, code: env.codes.get(PHONE) } });
    assert.equal(v.body.newUser, false);
    assert.notEqual(v.body.token, first);
    assert.equal((await env.call('GET', '/v1/orders', { token: first })).status, 200, 'both sessions work');
    await env.advance(30 * 24 * HOUR);
    assert.equal((await env.call('GET', '/v1/orders', { token: first })).status, 401);
  });

  test('neither the code nor the phone number reaches the logs', async () => {
    const env = apiEnv();
    await env.signIn(PHONE);
    const logged = JSON.stringify(env.log.lines);
    assert.ok(!logged.includes(env.codes.get(PHONE)!));
    assert.ok(!logged.includes('9812345678'));
  });
});
