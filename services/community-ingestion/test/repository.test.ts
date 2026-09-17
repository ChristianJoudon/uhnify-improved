import assert from 'node:assert/strict';
import test from 'node:test';
import type { MongoClient } from 'mongodb';
import {
  MemoryIngestionRepository,
  MongoIngestionRepository,
  type CandidateRecord,
} from '../src/repository.js';

const relationshipCandidate = (
  fingerprint: string,
  parentSourceItemKey: string,
  observationId: string,
  observedAt = new Date('2026-08-09T00:00:00.000Z'),
): CandidateRecord => ({
  id: fingerprint,
  sourceId: 'SEN-900',
  sourceItemKey: 'event:sample-tue-1300',
  entityHint: 'event',
  parentSourceItemKey,
  observationId,
  fingerprint,
  blockingKeys: ['sample-blocking-key'],
  normalizedFields: {
    title: 'Sample Support Group',
    recurrenceLabel: 'Tuesday at 1:00 pm',
    timeZone: 'Pacific/Honolulu',
  },
  summary: { title: 'Sample Support Group' },
  validationState: 'VALID',
  reviewStatus: 'PENDING',
  createdAt: observedAt,
  lastObservedAt: observedAt,
});

test('repository preserves an approved relationship fingerprint while admitting a moved revision', async () => {
  const repository = new MemoryIngestionRepository();
  const approvedRecord = relationshipCandidate(
    'fingerprint-group-a',
    'group:sample-group',
    'observation-group-a',
  );
  await repository.upsertCandidate(approvedRecord);
  approvedRecord.reviewStatus = 'APPROVED';

  const movedRecord = relationshipCandidate(
    'fingerprint-group-b',
    'group:replacement-group',
    'observation-group-b',
  );
  const movedResult = await repository.upsertCandidate(movedRecord);

  assert.deepEqual(movedResult, { id: movedRecord.id, created: true });
  assert.equal(repository.candidates.size, 2);
  assert.equal(approvedRecord.reviewStatus, 'APPROVED');
  assert.equal(approvedRecord.parentSourceItemKey, 'group:sample-group');
  assert.equal(approvedRecord.fingerprint, 'fingerprint-group-a');
  assert.equal(movedRecord.reviewStatus, 'PENDING');
  assert.equal(movedRecord.parentSourceItemKey, 'group:replacement-group');

  const approvedReplay = relationshipCandidate(
    approvedRecord.fingerprint,
    approvedRecord.parentSourceItemKey,
    'newer-approved-observation',
  );
  const replayResult = await repository.upsertCandidate(approvedReplay);

  assert.deepEqual(replayResult, { id: approvedRecord.id, created: false });
  assert.equal(approvedRecord.reviewStatus, 'APPROVED');
  assert.equal(approvedRecord.parentSourceItemKey, 'group:sample-group');
  assert.equal(approvedRecord.observationId, 'newer-approved-observation');
});

test('repository reopens approved A when it reappears after a later approved B', async () => {
  const repository = new MemoryIngestionRepository();
  const firstApproved = relationshipCandidate(
    'fingerprint-group-a',
    'group:sample-group',
    'observation-group-a',
    new Date('2026-08-09T00:00:00.000Z'),
  );
  await repository.upsertCandidate(firstApproved);
  firstApproved.reviewStatus = 'APPROVED';
  Object.assign(firstApproved as unknown as Record<string, unknown>, {
    reviewedAt: new Date('2026-08-09T00:05:00.000Z'),
    reviewedBy: 'reviewer-a',
    publicationState: 'COMPLETE',
    projectionVersion: 'support-projection.v1',
    projectionReferenceAt: new Date('2026-08-09T00:05:00.000Z'),
    canonicalTargets: [{ kind: 'event', id: 'canonical-a' }],
    approvalClaimToken: 'stale-claim-a',
    approvalClaimedAt: new Date('2026-08-09T00:04:00.000Z'),
    approvalClaimedBy: 'reviewer-a',
    lastProjectionErrorCode: 'stale-error',
    auditReference: 'review-item-a',
  });

  const laterApproved = relationshipCandidate(
    'fingerprint-group-b',
    'group:replacement-group',
    'observation-group-b',
    new Date('2026-08-09T01:00:00.000Z'),
  );
  await repository.upsertCandidate(laterApproved);
  laterApproved.reviewStatus = 'APPROVED';

  const reappearingFirst = relationshipCandidate(
    firstApproved.fingerprint,
    'group:sample-group',
    'observation-group-a-reappeared',
    new Date('2026-08-09T02:00:00.000Z'),
  );
  const result = await repository.upsertCandidate(reappearingFirst);

  assert.deepEqual(result, { id: firstApproved.id, created: false });
  assert.equal(firstApproved.reviewStatus, 'PENDING');
  assert.equal(firstApproved.observationId, 'observation-group-a-reappeared');
  assert.equal(laterApproved.reviewStatus, 'APPROVED');
  const reopened = firstApproved as unknown as Record<string, unknown>;
  for (const field of [
    'reviewedAt',
    'reviewedBy',
    'publicationState',
    'projectionVersion',
    'projectionReferenceAt',
    'canonicalTargets',
    'approvalClaimToken',
    'approvalClaimedAt',
    'approvalClaimedBy',
    'lastProjectionErrorCode',
  ]) assert.equal(reopened[field], undefined, `${field} must not survive republication`);
  assert.equal(reopened.auditReference, 'review-item-a', 'unrelated audit references are preserved');
});

test('repository keeps an identical replay of the current approved fingerprint approved', async () => {
  const repository = new MemoryIngestionRepository();
  const approved = relationshipCandidate(
    'fingerprint-current',
    'group:current-group',
    'observation-current',
    new Date('2026-08-09T00:00:00.000Z'),
  );
  await repository.upsertCandidate(approved);
  approved.reviewStatus = 'APPROVED';
  Object.assign(approved as unknown as Record<string, unknown>, {
    reviewedAt: new Date('2026-08-09T00:05:00.000Z'),
    reviewedBy: 'reviewer-current',
    publicationState: 'COMPLETE',
    canonicalTargets: [{ kind: 'event', id: 'canonical-current' }],
  });

  const replay = relationshipCandidate(
    approved.fingerprint,
    'group:current-group',
    'observation-current-replay',
    new Date('2026-08-09T01:00:00.000Z'),
  );
  replay.classificationSuggestion = {
    taxonomyVersion: 'matchbook-topics.v1',
    topicKey: 'support',
    subcategoryKey: 'general_support',
    confidence: 0.96,
    reasons: ['EXPLICIT_SUPPORT_TYPE'],
  };
  replay.recurringSeriesKey = `series:v1:${'a'.repeat(64)}`;
  await repository.upsertCandidate(replay);

  const current = approved as unknown as Record<string, unknown>;
  assert.equal(approved.reviewStatus, 'APPROVED');
  assert.equal(approved.observationId, 'observation-current-replay');
  assert.equal(current.publicationState, 'COMPLETE');
  assert.deepEqual(current.canonicalTargets, [{ kind: 'event', id: 'canonical-current' }]);
  assert.equal(current.reviewedBy, 'reviewer-current');
  assert.deepEqual(approved.classificationSuggestion, replay.classificationSuggestion);
  assert.equal(approved.recurringSeriesKey, replay.recurringSeriesKey);
});

test('Mongo repository marks reappearing approved A pending after a later approved B', async () => {
  const firstApproved = {
    _id: 'candidate-a',
    fingerprint: 'fingerprint-group-a',
    observationId: 'observation-group-a',
    reviewStatus: 'APPROVED',
    lastObservedAt: new Date('2026-08-09T00:00:00.000Z'),
    publicationState: 'COMPLETE',
    canonicalTargets: [{ kind: 'event', id: 'canonical-a' }],
  };
  const laterApproved = {
    _id: 'candidate-b',
    fingerprint: 'fingerprint-group-b',
    observationId: 'observation-group-b',
    reviewStatus: 'APPROVED',
    lastObservedAt: new Date('2026-08-09T01:00:00.000Z'),
  };
  let siblingFilter: Record<string, unknown> | undefined;
  let supersedeFilter: Record<string, unknown> | undefined;
  let candidateUpdate: Record<string, unknown> | undefined;
  const fakeClient = {
    db: () => ({
      collection: (name: string) => {
        if (name !== 'ingestion_candidates') throw new Error(`Unexpected collection ${name}`);
        return {
          findOne: async (filter: Record<string, unknown>) => {
            if (filter.fingerprint === firstApproved.fingerprint) return firstApproved;
            if (filter.reviewStatus === 'APPROVED') {
              siblingFilter = filter;
              return laterApproved;
            }
            return null;
          },
          updateMany: async (filter: Record<string, unknown>) => {
            supersedeFilter = filter;
            return { acknowledged: true };
          },
          updateOne: async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
            candidateUpdate = update;
            return { acknowledged: true };
          },
          insertOne: async () => {
            throw new Error('reappearing approved A must reuse its candidate');
          },
        };
      },
    }),
  } as unknown as MongoClient;
  const repository = new MongoIngestionRepository(fakeClient);
  const reappearingFirst = relationshipCandidate(
    firstApproved.fingerprint,
    'group:sample-group',
    'observation-group-a-reappeared',
    new Date('2026-08-09T02:00:00.000Z'),
  );

  const result = await repository.upsertCandidate(reappearingFirst);

  assert.deepEqual(result, { id: firstApproved._id, created: false });
  assert.deepEqual(siblingFilter?.lastObservedAt, { $gt: firstApproved.lastObservedAt });
  assert.equal(supersedeFilter?.reviewStatus, 'PENDING');
  assert.deepEqual(supersedeFilter?._id, { $ne: firstApproved._id });
  const setFields = candidateUpdate?.$set as Record<string, unknown> | undefined;
  assert.equal(setFields?.reviewStatus, 'PENDING');
  assert.equal(setFields?.observationId, 'observation-group-a-reappeared');
  const unsetFields = candidateUpdate?.$unset as Record<string, unknown> | undefined;
  for (const field of [
    'approvalClaimToken',
    'approvalClaimedAt',
    'approvalClaimedBy',
    'reviewedAt',
    'reviewedBy',
    'publicationState',
    'projectionVersion',
    'projectionReferenceAt',
    'canonicalTargets',
    'lastProjectionErrorCode',
  ]) assert.equal(unsetFields?.[field], '', `${field} must be cleared before republication`);
});

test('Mongo repository keeps identical replay of the current approved fingerprint approved', async () => {
  const currentApproved = {
    _id: 'candidate-current',
    fingerprint: 'fingerprint-current',
    observationId: 'observation-current',
    reviewStatus: 'APPROVED',
    lastObservedAt: new Date('2026-08-09T00:00:00.000Z'),
    publicationState: 'COMPLETE',
    canonicalTargets: [{ kind: 'event', id: 'canonical-current' }],
  };
  let candidateUpdate: Record<string, unknown> | undefined;
  const fakeClient = {
    db: () => ({
      collection: (name: string) => {
        if (name !== 'ingestion_candidates') throw new Error(`Unexpected collection ${name}`);
        return {
          findOne: async (filter: Record<string, unknown>) => (
            filter.fingerprint === currentApproved.fingerprint ? currentApproved : null
          ),
          updateMany: async () => ({ acknowledged: true }),
          updateOne: async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
            candidateUpdate = update;
            return { acknowledged: true };
          },
          insertOne: async () => {
            throw new Error('identical approved replay must reuse its candidate');
          },
        };
      },
    }),
  } as unknown as MongoClient;
  const repository = new MongoIngestionRepository(fakeClient);
  const replay = relationshipCandidate(
    currentApproved.fingerprint,
    'group:current-group',
    'observation-current-replay',
    new Date('2026-08-09T01:00:00.000Z'),
  );
  replay.classificationSuggestion = {
    taxonomyVersion: 'matchbook-topics.v1',
    topicKey: 'support',
    subcategoryKey: 'general_support',
    confidence: 0.96,
    reasons: ['EXPLICIT_SUPPORT_TYPE'],
  };
  replay.recurringSeriesKey = `series:v1:${'b'.repeat(64)}`;

  const result = await repository.upsertCandidate(replay);

  assert.deepEqual(result, { id: currentApproved._id, created: false });
  const setFields = candidateUpdate?.$set as Record<string, unknown> | undefined;
  assert.equal(setFields?.reviewStatus, undefined);
  assert.equal(setFields?.observationId, 'observation-current-replay');
  assert.deepEqual(setFields?.classificationSuggestion, replay.classificationSuggestion);
  assert.equal(setFields?.recurringSeriesKey, replay.recurringSeriesKey);
  assert.equal(candidateUpdate?.$unset, undefined);
});

test('Mongo repository reuses a parentless legacy candidate when its observation proves the same parent', async () => {
  const legacyDocument = {
    _id: 'legacy-candidate-id',
    fingerprint: 'legacy-fingerprint',
    observationId: 'legacy-observation-id',
    reviewStatus: 'PENDING',
  };
  let observationLookups = 0;
  let supersedeFilter: Record<string, unknown> | undefined;
  let candidateUpdate: Record<string, unknown> | undefined;
  const fakeClient = {
    db: () => ({
      collection: (name: string) => {
        if (name === 'source_observations') {
          return {
            findOne: async () => {
              observationLookups += 1;
              return {
                _id: 'legacy-observation-id',
                rawFields: { groupKey: 'sample-group' },
              };
            },
          };
        }
        if (name === 'ingestion_candidates') {
          return {
            findOne: async (filter: Record<string, unknown>) => (
              filter.fingerprint === 'legacy-fingerprint' ? legacyDocument : null
            ),
            updateMany: async (filter: Record<string, unknown>) => {
              supersedeFilter = filter;
              return { acknowledged: true };
            },
            updateOne: async (_filter: Record<string, unknown>, update: Record<string, unknown>) => {
              candidateUpdate = update;
              return { acknowledged: true };
            },
            insertOne: async () => {
              throw new Error('unchanged legacy relationship must not insert a duplicate candidate');
            },
          };
        }
        throw new Error(`Unexpected collection ${name}`);
      },
    }),
  } as unknown as MongoClient;
  const repository = new MongoIngestionRepository(fakeClient);
  const relationshipRevision = relationshipCandidate(
    'relationship-aware-fingerprint',
    'group:sample-group',
    'current-observation-id',
  );

  const result = await repository.upsertCandidate(relationshipRevision, 'legacy-fingerprint');

  assert.deepEqual(result, { id: 'legacy-candidate-id', created: false });
  assert.equal(observationLookups, 1);
  assert.deepEqual(supersedeFilter?._id, { $ne: 'legacy-candidate-id' });
  const setFields = candidateUpdate?.$set as Record<string, unknown> | undefined;
  assert.equal(setFields?.parentSourceItemKey, 'group:sample-group');
  assert.equal(setFields?.observationId, 'current-observation-id');
  assert.equal(setFields?.reviewStatus, undefined, 'the pending decision is not reopened or rewritten');
});
