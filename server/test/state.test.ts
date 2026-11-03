// Order state machine and the pure part of a sync. Run: npm run test:server
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_STATUSES, type OrderStatus } from '../../shared/lab-bundle.ts';
import { canCancel, canReschedule, checkMove, FINAL_STATUSES, PARTNER_STATUSES, type MoveSource } from '../src/orders/state.ts';
import { decideSync } from '../src/orders/sync.ts';
import { newOrderRecord, type OrderRecord } from '../src/store/types.ts';

const ok = (from: OrderStatus, to: OrderStatus, source: MoveSource) => checkMove(from, to, source).ok;
const reason = (from: OrderStatus, to: OrderStatus, source: MoveSource) => {
  const r = checkMove(from, to, source);
  return r.ok ? 'ok' : r.reason;
};

describe('partner moves', () => {
  test('forward progress is accepted, including skipped steps', () => {
    const line: OrderStatus[] = ['placing', 'booked', 'collector_assigned', 'sample_collected', 'processing', 'partial_report', 'report_ready'];
    for (let i = 0; i < line.length; i++) {
      for (let j = i + 1; j < line.length; j++) assert.ok(ok(line[i], line[j], 'partner'), `${line[i]} → ${line[j]}`);
    }
  });

  test('going back is refused as backward', () => {
    assert.equal(reason('report_ready', 'booked', 'partner'), 'backward');
    assert.equal(reason('processing', 'sample_collected', 'partner'), 'backward');
    assert.equal(reason('report_ready', 'partial_report', 'partner'), 'backward');
    assert.equal(reason('sample_collected', 'collector_assigned', 'partner'), 'backward');
  });

  test('a rescheduled visit or reassigned collector can go back to booked', () => {
    assert.ok(ok('collector_assigned', 'booked', 'partner'));
    assert.equal(reason('sample_collected', 'booked', 'partner'), 'backward');
  });

  test('a rejected sample: reported after booking up to a partial report, then the visit starts again', () => {
    for (const from of ['booked', 'collector_assigned', 'sample_collected', 'processing', 'partial_report'] as const) {
      assert.ok(ok(from, 'recollection_needed', 'partner'), from);
    }
    assert.equal(reason('placing', 'recollection_needed', 'partner'), 'not_allowed');
    assert.equal(reason('report_ready', 'recollection_needed', 'partner'), 'not_allowed');
    for (const to of ['booked', 'collector_assigned', 'sample_collected', 'processing', 'report_ready'] as const) {
      assert.ok(ok('recollection_needed', to, 'partner'), to);
    }
    assert.equal(reason('recollection_needed', 'placing', 'partner'), 'not_allowed');
  });

  test('the partner can cancel at any unfinished stage', () => {
    for (const from of ORDER_STATUSES) {
      if (FINAL_STATUSES.has(from)) continue;
      assert.ok(ok(from, 'cancelled', 'partner'), from);
    }
  });

  test('statuses that are ours to set are refused from a partner', () => {
    for (const to of ['created', 'payment_pending', 'paid', 'placing', 'delivered', 'expired', 'failed'] as const) {
      assert.ok(!PARTNER_STATUSES.has(to));
      assert.equal(reason('booked', to, 'partner'), 'not_allowed', to);
    }
  });
});

describe('local moves', () => {
  test('payment, placing and delivery follow the table', () => {
    assert.ok(ok('created', 'payment_pending', 'local'));
    assert.ok(ok('created', 'placing', 'local'));
    assert.ok(ok('payment_pending', 'paid', 'local'));
    assert.ok(ok('paid', 'placing', 'local'));
    assert.ok(ok('placing', 'booked', 'local'));
    assert.ok(ok('placing', 'failed', 'local'));
    assert.ok(ok('report_ready', 'delivered', 'local'));
    assert.ok(ok('report_ready', 'expired', 'local'));
    assert.ok(ok('partial_report', 'expired', 'local'));
    assert.equal(reason('partial_report', 'delivered', 'local'), 'not_allowed');
    assert.equal(reason('booked', 'report_ready', 'local'), 'not_allowed');
    assert.equal(reason('placing', 'cancelled', 'local'), 'not_allowed');
  });

  test('a user can cancel until the sample is collected, and reschedule a visit not yet made', () => {
    const cancellable = ORDER_STATUSES.filter(canCancel);
    assert.deepEqual(cancellable, ['created', 'payment_pending', 'paid', 'booked', 'collector_assigned', 'recollection_needed']);
    assert.deepEqual(ORDER_STATUSES.filter(canReschedule), ['booked', 'collector_assigned', 'recollection_needed']);
    assert.ok(ok('collector_assigned', 'booked', 'local'));
  });
});

test('finished orders do not move, and a repeat is unchanged', () => {
  for (const from of FINAL_STATUSES) {
    for (const to of ORDER_STATUSES) {
      if (to === from) continue;
      assert.equal(reason(from, to, 'partner'), 'final', `${from} → ${to}`);
      assert.equal(reason(from, to, 'local'), 'final', `${from} → ${to}`);
    }
  }
  for (const s of ORDER_STATUSES) assert.equal(reason(s, s, 'partner'), 'unchanged');
});

describe('decideSync', () => {
  const T = Date.parse('2026-11-03T10:00:00+05:30');
  const order = (over: Partial<OrderRecord> = {}): OrderRecord => newOrderRecord({
    id: 'ord_1', userId: 'u1', partner: 'fake', partnerRef: 'FL000001', status: 'booked',
    partnerStatus: 'ORDER_PLACED', partnerStatusAt: T, lastSyncedAt: T, createdAt: T, ...over,
  });
  const at = (minutes: number) => new Date(T + minutes * 60_000).toISOString();

  test('applies a newer allowed status with one event', () => {
    const d = decideSync(order(), { status: 'collector_assigned', partnerStatus: 'PHLEBO_ASSIGNED', at: at(5) }, 'webhook', T + 6 * 60_000);
    assert.deepEqual(d.outcome, { kind: 'applied', from: 'booked', to: 'collector_assigned' });
    assert.equal(d.change?.next.status, 'collector_assigned');
    assert.equal(d.change?.next.partnerStatusAt, T + 5 * 60_000);
    assert.equal(d.change?.events.length, 1);
    assert.equal(d.change?.events[0].source, 'webhook');
  });

  test('an older read is stale and a repeat is a duplicate; neither writes an event', () => {
    const stale = decideSync(order({ status: 'processing', partnerStatus: 'IN_LAB', partnerStatusAt: T + 10 * 60_000 }),
      { status: 'sample_collected', partnerStatus: 'SAMPLE_COLLECTED', at: at(5) }, 'poll', T + 20 * 60_000);
    assert.equal(stale.outcome.kind, 'stale');
    assert.equal(stale.change?.next.status, 'processing');
    assert.deepEqual(stale.change?.events, []);
    assert.equal(stale.change?.next.lastSyncedAt, T + 20 * 60_000);

    const dup = decideSync(order(), { status: 'booked', partnerStatus: 'ORDER_PLACED', at: at(0) }, 'webhook', T + 60_000);
    assert.equal(dup.outcome.kind, 'duplicate');
    assert.deepEqual(dup.change?.events, []);
  });

  test('a new partner status that keeps our status is noted (amended report)', () => {
    const d = decideSync(order({ status: 'report_ready', partnerStatus: 'REPORT_READY' }),
      { status: 'report_ready', partnerStatus: 'REPORT_AMENDED', at: at(30) }, 'webhook', T + 31 * 60_000);
    assert.deepEqual(d.outcome, { kind: 'noted', status: 'report_ready', partnerStatus: 'REPORT_AMENDED', reason: 'unchanged' });
    assert.equal(d.change?.events[0].partnerStatus, 'REPORT_AMENDED');
    assert.equal(d.change?.events[0].note, undefined);
  });

  test('a newer status that goes backwards or is unknown is noted, not applied', () => {
    const back = decideSync(order({ status: 'report_ready', partnerStatus: 'REPORT_READY' }),
      { status: 'booked', partnerStatus: 'ORDER_PLACED', at: at(40) }, 'poll', T + 41 * 60_000);
    assert.equal(back.outcome.kind, 'noted');
    assert.equal(back.change?.next.status, 'report_ready');
    assert.match(back.change?.events[0].note ?? '', /backward/);

    const unknown = decideSync(order(), { status: 'unknown', partnerStatus: 'ON_HOLD', at: at(3) }, 'webhook', T + 4 * 60_000);
    assert.deepEqual(unknown.outcome, { kind: 'noted', status: 'booked', partnerStatus: 'ON_HOLD', reason: 'unknown_status' });
    assert.equal(unknown.change?.next.partnerStatus, 'ON_HOLD');
  });
});
