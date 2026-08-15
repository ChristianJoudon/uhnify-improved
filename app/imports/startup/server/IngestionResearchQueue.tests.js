/* eslint-env mocha */
import { assert } from 'chai';
import {
  CommunitySources,
  IngestionCandidates,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD,
  INGESTION_RESEARCH_METHODS,
} from '../../api/ingestion/IngestionResearch';
import {
  INGESTION_RUN_ACTIVE_GUARD,
  IngestionRunRequests,
} from '../../api/ingestion/IngestionRunRequests';
import {
  callAs,
  makeUser,
  resetAll,
} from './testFixtures';
import {
  candidateResearchBasisKey,
} from './IngestionResearchQueue';

const addSource = (sourceId = 'SRC-001') => CommunitySources.insert({
  _id: sourceId,
  id: sourceId,
  sourceId,
  displayName: 'Fixture community calendar',
  publisherName: 'Fixture publisher',
  publisherUrl: 'https://events.example.test/calendar',
  permission: 'PROBE_REQUIRED',
});

const addCandidate = (overrides = {}) => IngestionCandidates.insert({
  _id: 'candidate-research-fixture',
  sourceId: 'SRC-001',
  sourceItemKey: 'event:fixture',
  fingerprint: 'fixture-fingerprint',
  observationId: 'fixture-observation',
  entityHint: 'event',
  reviewStatus: 'PENDING',
  normalizedFields: { title: 'Fixture event' },
  ...overrides,
});

describe('candidate detail research queue', function () {
  let admin;

  beforeEach(function () {
    resetAll();
    CommunitySources.remove({});
    IngestionCandidates.remove({});
    IngestionRunRequests.remove({});
    admin = makeUser({ admin: true });
    addSource();
  });

  afterEach(function () {
    CommunitySources.remove({});
    IngestionCandidates.remove({});
    IngestionRunRequests.remove({});
  });

  it('durably queues a candidate behind a busy source instead of discarding it', function () {
    const candidateId = addCandidate();
    IngestionRunRequests.insert({
      _id: 'source-run-active',
      sourceId: 'SRC-001',
      status: 'QUEUED',
      executionMode: 'PRACTICE',
      activeGuard: INGESTION_RUN_ACTIVE_GUARD,
      availableAt: new Date(),
      requestedAt: new Date(),
      attempts: 0,
    });

    const result = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);

    assert.equal(result.status, 'QUEUED');
    assert.equal(result.busyScope, 'SOURCE');
    const request = IngestionRunRequests.findOne(result.requestId);
    assert.equal(request.status, 'QUEUED');
    assert.isUndefined(request.activeGuard, 'a waiter does not steal the source guard');
    assert.equal(request.candidateActiveGuard, INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD);
    const candidate = IngestionCandidates.findOne(candidateId);
    assert.equal(candidate.research.status, 'QUEUED');
    assert.equal(candidate.research.queue.progressStage, 'WAITING_FOR_SOURCE');
    assert.match(candidate.research.queue.progressMessage, /will not be discarded/i);

    const duplicate = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);
    assert.equal(duplicate.status, 'ALREADY_RUNNING');
    assert.equal(duplicate.busyScope, 'CANDIDATE');
    assert.equal(duplicate.activeRequestId, result.requestId);
    assert.equal(IngestionRunRequests.find({
      candidateId,
      candidateActiveGuard: INGESTION_RESEARCH_CANDIDATE_ACTIVE_GUARD,
    }).count(), 1);
  });

  it('returns current successful research without enqueueing duplicate work', function () {
    const candidateId = addCandidate({
      normalizedFields: {
        title: 'Fixture event',
        location: 'Fixture Hall, 123 Main Street',
        localStart: '2026-08-15T09:00:00-10:00',
      },
    });
    const basisKey = candidateResearchBasisKey('fixture-fingerprint', 0);
    IngestionCandidates.update(candidateId, {
      $set: {
        research: {
          status: 'SUCCEEDED',
          retryable: false,
          requestId: 'completed-research',
          basis: {
            candidateFingerprint: 'fixture-fingerprint',
            observationId: 'fixture-observation',
            editorialRevision: 0,
            basisKey,
          },
        },
      },
    });

    const result = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);

    assert.equal(result.status, 'ALREADY_CURRENT');
    assert.equal(result.cachedRequestId, 'completed-research');
    assert.equal(IngestionRunRequests.find({ candidateId, status: 'QUEUED' }).count(), 0);
  });

  it('requeues a false-success cache when an invalid end time still needs research', function () {
    const candidateId = addCandidate({
      normalizedFields: {
        title: 'Fixture event',
        location: 'Fixture Hall, 123 Main Street',
        localStart: '2026-08-15T09:00:00-10:00',
        localEnd: '2026-08-15T08:00:00-10:00',
      },
    });
    const basisKey = candidateResearchBasisKey('fixture-fingerprint', 0);
    IngestionCandidates.update(candidateId, {
      $set: {
        research: {
          status: 'SUCCEEDED',
          retryable: false,
          requestId: 'false-success-research',
          missingFields: [],
          fieldSuggestions: [],
          basis: {
            candidateFingerprint: 'fixture-fingerprint',
            observationId: 'fixture-observation',
            editorialRevision: 0,
            basisKey,
          },
        },
      },
    });

    const result = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);

    assert.equal(result.status, 'QUEUED');
    assert.deepEqual(
      IngestionCandidates.findOne(candidateId).research.missingFields,
      ['localEnd'],
    );
  });

  it('binds deduplication to the candidate editorial revision', function () {
    const candidateId = addCandidate();
    const first = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);
    IngestionCandidates.update(candidateId, { $set: { editorialRevision: 1 } });
    const second = callAs(admin, INGESTION_RESEARCH_METHODS.request, candidateId);

    assert.equal(first.status, 'QUEUED');
    assert.equal(second.status, 'QUEUED');
    assert.notEqual(first.requestId, second.requestId);
    assert.notEqual(
      IngestionRunRequests.findOne(first.requestId).researchBasisKey,
      IngestionRunRequests.findOne(second.requestId).researchBasisKey,
    );
  });
});
