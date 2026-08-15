import assert from 'node:assert/strict';
import test from 'node:test';
import type { Collection, WithId } from 'mongodb';
import {
  claimNextRequest,
  governedArtifactRootsFor,
  researchRetryDelayMs,
  retryableWorkerError,
  type RunRequest,
} from '../src/worker.js';

const request = (overrides: Partial<WithId<RunRequest>> = {}): WithId<RunRequest> => ({
  _id: 'research-a',
  sourceId: 'SRC-001',
  status: 'QUEUED',
  executionMode: 'RESEARCH',
  candidateId: 'candidate-a',
  candidateFingerprint: 'fingerprint-a',
  candidateObservationId: 'observation-a',
  candidateEditorialRevision: 0,
  researchBasisKey: 'basis-a',
  candidateActiveGuard: 'ACTIVE',
  availableAt: new Date('2026-08-10T00:00:00.000Z'),
  requestedAt: new Date('2026-08-10T00:00:00.000Z'),
  attempts: 0,
  maxAttempts: 3,
  ...overrides,
});

const cursorFor = (rows: WithId<RunRequest>[]) => ({
  sort() { return this; },
  limit() { return this; },
  async toArray() { return rows; },
});

test('a candidate waiter acquires the source guard only when a worker claims it', async () => {
  const waiter = request();
  let call = 0;
  const fake = {
    async findOneAndUpdate(_filter: unknown, update: Record<string, Record<string, unknown>>) {
      call += 1;
      if (call === 1) return null;
      return {
        ...waiter,
        ...update.$set,
        attempts: 1,
      };
    },
    find() { return cursorFor([waiter]); },
  } as unknown as Collection<RunRequest>;

  const claimed = await claimNextRequest(fake, 'worker-a');

  assert.equal(claimed?._id, waiter._id);
  assert.equal(claimed?.status, 'RUNNING');
  assert.equal(claimed?.activeGuard, 'ACTIVE');
  assert.equal(claimed?.candidateActiveGuard, 'ACTIVE');
  assert.equal(claimed?.attempts, 1);
});

test('source contention leaves the first candidate queued and claims another source', async () => {
  const blocked = request({ _id: 'research-blocked', sourceId: 'SRC-001' });
  const claimable = request({ _id: 'research-claimable', sourceId: 'SRC-002' });
  let call = 0;
  const fake = {
    async findOneAndUpdate(_filter: unknown, update: Record<string, Record<string, unknown>>) {
      call += 1;
      if (call === 1) return null;
      if (call === 2) throw Object.assign(new Error('duplicate source guard'), { code: 11000 });
      return { ...claimable, ...update.$set, attempts: 1 };
    },
    find() { return cursorFor([blocked, claimable]); },
  } as unknown as Collection<RunRequest>;

  const claimed = await claimNextRequest(fake, 'worker-a');

  assert.equal(claimed?._id, claimable._id);
  assert.equal(blocked.status, 'QUEUED', 'the contended candidate must not become terminal');
  assert.equal(call, 3);
});

test('retry policy backs off transient failures and stops retrying structural errors', () => {
  assert.equal(retryableWorkerError('FETCH_TIMEOUT'), true);
  assert.equal(retryableWorkerError('HTTP_5XX'), true);
  assert.equal(retryableWorkerError('RESEARCH_BASIS_STALE'), false);
  assert.equal(retryableWorkerError('RETAINED_ARTIFACT_HASH_MISMATCH'), false);
  assert.equal(researchRetryDelayMs(1), 5_000);
  assert.equal(researchRetryDelayMs(2), 10_000);
  assert.equal(researchRetryDelayMs(3, 45_000), 45_000);
});

test('sensitive research checks the governed support artifact store before community storage', () => {
  const sensitive = governedArtifactRootsFor('SEN-001');
  const publicSource = governedArtifactRootsFor('SRC-001');
  assert.match(sensitive[0] ?? '', /[.]artifacts\/support$/);
  assert.match(sensitive[1] ?? '', /[.]artifacts\/community$/);
  assert.match(publicSource[0] ?? '', /[.]artifacts\/community$/);
  assert.match(publicSource[1] ?? '', /[.]artifacts\/support$/);

  const configured = governedArtifactRootsFor('SEN-001', '/operator/governed-artifacts');
  assert.equal(configured[0], '/operator/governed-artifacts');
  assert.equal(configured.length, 3);
});
