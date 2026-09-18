import assert from 'node:assert/strict';
import test from 'node:test';
import type { Collection, MongoClient } from 'mongodb';
import { scheduleDueSources, type RunRequest } from '../src/worker.js';

/**
 * The scheduler is what makes "cleared for automation" mean something: before
 * it, the worker only ever ran what an administrator queued by hand.
 */
const source = (overrides: Record<string, unknown> = {}) => ({
  _id: 'SRC-006',
  id: 'SRC-006',
  enabled: true,
  permission: 'AUTOMATED_ALLOWED',
  polling: { intervalMinutes: 360, jitterPercent: 0 },
  nextRunAt: new Date('2026-09-18T00:00:00.000Z'),
  ...overrides,
});

const harness = (rows: Record<string, unknown>[], { refuseInsert = false } = {}) => {
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const sources = {
    find(filter: Record<string, unknown>) {
      // The real query: enabled, cleared, and due.
      const now = (filter.$or as Array<Record<string, Record<string, Date>>>)[0]!.nextRunAt!.$lte!;
      return {
        async toArray() {
          return rows.filter(row => row.enabled === true
            && row.permission === 'AUTOMATED_ALLOWED'
            && (!row.nextRunAt || (row.nextRunAt as Date) <= now));
        },
      };
    },
    async updateOne(_filter: unknown, update: Record<string, unknown>) { updates.push(update); },
  };
  const client = { db: () => ({ collection: () => sources }) } as unknown as MongoClient;
  const requests = {
    async insertOne(doc: Record<string, unknown>) {
      if (refuseInsert) throw Object.assign(new Error('dup'), { code: 11000 });
      inserted.push(doc);
    },
  } as unknown as Collection<RunRequest>;
  return { client, requests, inserted, updates };
};

test('queues one AUTOMATIC request per due, cleared, enabled source and moves its next run forward', async () => {
  const now = new Date('2026-09-18T01:00:00.000Z');
  const { client, requests, inserted, updates } = harness([
    source(),
    source({ _id: 'SRC-001', id: 'SRC-001' }),
    source({ _id: 'SRC-009', id: 'SRC-009', enabled: false }),
    source({ _id: 'SRC-012', id: 'SRC-012', permission: 'PROBE_REQUIRED' }),
    source({ _id: 'SRC-003', id: 'SRC-003', nextRunAt: new Date('2026-09-18T02:00:00.000Z') }),
  ]);
  const queued = await scheduleDueSources(client, requests, now);
  assert.equal(queued, 2);
  assert.deepEqual(inserted.map(r => r.sourceId).sort(), ['SRC-001', 'SRC-006']);
  inserted.forEach(r => {
    assert.equal(r.executionMode, 'AUTOMATIC');
    assert.equal(r.status, 'QUEUED');
    assert.equal(r.activeGuard, 'ACTIVE');
    assert.equal(r.requestedBy, 'scheduler');
  });
  const next = (updates[0]!.$set as { nextRunAt: Date }).nextRunAt;
  assert.equal(next.getTime(), now.getTime() + 360 * 60_000, 'six hours on, no jitter asked for');
});

test('a source with a run already queued or running is not queued again, and still waits its interval', async () => {
  const { client, requests, inserted, updates } = harness([source()], { refuseInsert: true });
  const queued = await scheduleDueSources(client, requests, new Date('2026-09-18T01:00:00.000Z'));
  assert.equal(queued, 0);
  assert.equal(inserted.length, 0);
  assert.equal(updates.length, 1, 'nextRunAt moved before the insert was refused');
});

test('jitter stays inside the registry percentage', async () => {
  const now = new Date('2026-09-18T01:00:00.000Z');
  for (let i = 0; i < 20; i += 1) {
    const { client, requests, updates } = harness([source({ polling: { intervalMinutes: 60, jitterPercent: 15 } })]);
    await scheduleDueSources(client, requests, now);
    const next = (updates[0]!.$set as { nextRunAt: Date }).nextRunAt.getTime() - now.getTime();
    assert.ok(next >= 51 * 60_000 && next <= 69 * 60_000, `${next / 60_000} minutes`);
  }
});
