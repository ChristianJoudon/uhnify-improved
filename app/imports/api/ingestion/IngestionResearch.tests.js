/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Profiles } from '../profiles/Profiles';
import {
  CommunitySources,
  IngestionCandidates,
} from './IngestionData';
import {
  INGESTION_RESEARCH_METHODS,
  INGESTION_RESEARCH_PUBLICATION,
  INGESTION_RESEARCH_REQUEST_STATUS,
  INGESTION_WORKER_HEALTH_PUBLICATION,
  IngestionWorkerHealth,
} from './IngestionResearch';
import {
  IngestionRunRequests,
} from './IngestionRunRequests';
import {
  candidateResearchBasisKey,
  ensureIngestionResearchIndexes,
} from '../../startup/server/IngestionResearchQueue';
import { ensureIngestionRunRequestIndexes } from '../../startup/server/CommunityIngestionRunQueue';
import { rateLimitFor } from '../../startup/server/rateLimits';
import {
  callAs,
  errorFrom,
  makeUser,
} from '../../startup/server/testFixtures';

const publishAs = (userId, name) => {
  const handler = Meteor.server.publish_handlers[name];
  if (!handler) throw new Error(`No such publication: ${name}`);
  return handler.apply({ userId, ready: () => null, onStop: () => {} }, []);
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

const addSource = (sourceId = 'SRC-901') => CommunitySources.insert({
  _id: sourceId,
  id: sourceId,
  slug: sourceId.toLowerCase(),
  displayName: `Source ${sourceId}`,
});

const addCandidate = ({
  id = 'candidate_research_1',
  sourceId = 'SRC-901',
  entityHint = 'event',
  normalizedFields,
  editorialRevision,
  editorialOverrides,
} = {}) => IngestionCandidates.insert({
  _id: id,
  sourceId,
  sourceItemKey: `${id}-source-item`,
  fingerprint: `${id}-fingerprint`,
  observationId: `${id}-observation`,
  entityHint,
  normalizedFields: normalizedFields || {
    title: 'Community cleanup',
    localStart: '2026-08-15T08:30:00-10:00',
    timeZone: 'Pacific/Honolulu',
    sourceUrl: 'https://fixture.example/events/cleanup',
  },
  ...(editorialRevision !== undefined ? { editorialRevision } : {}),
  ...(editorialOverrides ? { editorialOverrides } : {}),
});

const clean = () => {
  IngestionRunRequests.remove({});
  IngestionWorkerHealth.remove({});
  IngestionCandidates.remove({});
  CommunitySources.remove({});
  Meteor.roleAssignment.remove({});
  Meteor.users.remove({});
  Profiles.collection.remove({});
};

if (Meteor.isServer) {
  describe('candidate research queue boundary', function () {
    this.timeout(10000);

    before(async function () {
      clean();
      await ensureIngestionRunRequestIndexes();
      await ensureIngestionResearchIndexes();
    });

    beforeEach(function () {
      clean();
    });

    after(function () {
      clean();
    });

    it('allows only administrators and keeps the enqueue method synchronous', function () {
      addSource();
      addCandidate();
      const member = makeUser();
      const admin = makeUser({ admin: true });

      assert.equal(
        errorFrom(() => callAs(null, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1')),
        'not-logged-in',
      );
      assert.equal(
        errorFrom(() => callAs(member, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1')),
        'not-authorized',
      );

      const result = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      assert.notInstanceOf(result, Promise);
      assert.equal(result.status, INGESTION_RESEARCH_REQUEST_STATUS.queued);
      assert.equal(result.executionMode, 'RESEARCH');
      const stored = IngestionRunRequests.findOne(result.requestId);
      assert.equal(stored.candidateId, 'candidate_research_1');
      assert.isUndefined(stored.activeGuard, 'queued candidate research waits to acquire its source guard');
      assert.equal(stored.candidateActiveGuard, 'ACTIVE');
      ['url', 'query', 'provider', 'adapter', 'command', 'artifactPath'].forEach(field => {
        assert.notProperty(stored, field);
      });
      const candidate = IngestionCandidates.findOne('candidate_research_1');
      assert.equal(candidate.research.status, 'QUEUED');
      assert.equal(candidate.research.requestId, result.requestId);
      assert.deepEqual(candidate.research.attempts, []);
      assert.deepEqual(candidate.research.evidence, []);
      assert.deepEqual(candidate.research.fieldSuggestions, []);
    });

    it('accepts only one existing candidate id and resolves its registered source server-side', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate();

      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_RESEARCH_METHODS.request, 'https://bad.example/?q=run')),
        'invalid-candidate-id',
      );
      assert.match(
        String(errorFrom(() => callAs(admin, INGESTION_RESEARCH_METHODS.request, {
          candidateId: 'candidate_research_1',
          url: 'https://bad.example',
        }))),
        /Match error|Expected string/i,
      );
      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_missing')),
        'candidate-not-found',
      );

      CommunitySources.remove({});
      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1')),
        'source-not-found',
      );
      assert.equal(IngestionRunRequests.find().count(), 0);
    });

    it('does not research fields already satisfied by curator overrides', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate({
        editorialRevision: 2,
        editorialOverrides: {
          location: 'Curator-confirmed park',
          schedule: {
            kind: 'ONE_TIME',
            localStart: '2026-08-15T08:30:00-10:00',
            localEnd: '2026-08-15T10:00:00-10:00',
          },
        },
      });

      callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      const fields = IngestionCandidates.findOne('candidate_research_1').research.missingFields;
      assert.notInclude(fields, 'location');
      assert.notInclude(fields, 'localStart');
      assert.notInclude(fields, 'localEnd');
      assert.deepEqual(fields, []);
    });

    it('requires a recurrence label for groups even when source data has a one-time date', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate({
        entityHint: 'group',
        normalizedFields: {
          title: 'Community support group',
          location: 'Lihuʻe community room',
          localStart: '2026-08-15T18:00:00-10:00',
          localEnd: '2026-08-15T19:00:00-10:00',
          sourceUrl: 'https://fixture.example/groups/support',
        },
      });

      callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      const fields = IngestionCandidates.findOne('candidate_research_1').research.missingFields;
      assert.deepEqual(fields, ['recurrenceLabel']);
      assert.notInclude(fields, 'localStart');
    });

    it('deduplicates a completed result only for the same basis and observation', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate();
      const first = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      const candidate = IngestionCandidates.findOne('candidate_research_1');
      IngestionRunRequests.update(first.requestId, {
        $set: { status: 'SUCCEEDED' },
        $unset: { activeGuard: '', candidateActiveGuard: '' },
      });
      IngestionCandidates.update(candidate._id, {
        $set: {
          'research.status': 'SUCCEEDED',
          'research.retryable': false,
          'research.finishedAt': new Date(),
        },
      });

      const cached = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      assert.equal(cached.status, INGESTION_RESEARCH_REQUEST_STATUS.alreadyCurrent);
      assert.equal(cached.cachedRequestId, first.requestId);
      assert.equal(IngestionRunRequests.find({ candidateId: candidate._id }).count(), 2);
      assert.equal(IngestionCandidates.findOne(candidate._id).research.requestId, first.requestId);

      IngestionCandidates.update(candidate._id, {
        $set: { editorialRevision: 1 },
      });
      const revised = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      assert.equal(revised.status, INGESTION_RESEARCH_REQUEST_STATUS.queued);
      assert.notEqual(revised.requestId, first.requestId);
    });

    it('re-enqueues a transient unavailable result for the same review basis', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate();
      const first = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      IngestionRunRequests.update(first.requestId, {
        $set: { status: 'SUCCEEDED' },
        $unset: { activeGuard: '', candidateActiveGuard: '' },
      });
      IngestionCandidates.update('candidate_research_1', {
        $set: {
          'research.status': 'UNAVAILABLE',
          'research.retryable': true,
          'research.errorCode': 'SEARCH_PROVIDER_TIMEOUT',
          'research.finishedAt': new Date(),
        },
      });

      const retry = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      assert.equal(retry.status, INGESTION_RESEARCH_REQUEST_STATUS.queued);
      assert.notEqual(retry.requestId, first.requestId);
      assert.equal(IngestionCandidates.findOne('candidate_research_1').research.requestId, retry.requestId);
    });

    it('durably queues a candidate when the source already has active work', function () {
      const admin = makeUser({ admin: true });
      addSource();
      addCandidate({ id: 'candidate_research_1' });
      addCandidate({ id: 'candidate_research_2' });
      const first = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_1');
      IngestionRunRequests.update(first.requestId, {
        $set: { status: 'RUNNING', activeGuard: 'ACTIVE' },
      });
      const duplicate = callAs(admin, INGESTION_RESEARCH_METHODS.request, 'candidate_research_2');

      assert.equal(duplicate.status, INGESTION_RESEARCH_REQUEST_STATUS.queued);
      assert.equal(duplicate.busyScope, 'SOURCE');
      assert.equal(IngestionCandidates.findOne('candidate_research_2').research.status, 'QUEUED');
      assert.equal(
        IngestionCandidates.findOne('candidate_research_2').research.queue.progressStage,
        'WAITING_FOR_SOURCE',
      );
      assert.equal(IngestionRunRequests.find({ activeGuard: 'ACTIVE' }).count(), 1);
    });

    it('publishes only the safe research projection to administrators', function () {
      const admin = makeUser({ admin: true });
      const member = makeUser();
      addCandidate();
      const basisKey = candidateResearchBasisKey('candidate_research_1-fingerprint', 0);
      IngestionCandidates.update('candidate_research_1', {
        $set: {
          research: {
            contractVersion: 'candidate-research.v2',
            requestId: 'request-private-projection',
            status: 'PARTIAL',
            basis: {
              candidateFingerprint: 'private-fingerprint',
              observationId: 'candidate_research_1-observation',
              editorialRevision: 0,
              basisKey,
            },
            missingFields: ['description'],
            attempts: [{
              strategy: 'WEB_SEARCH_PROVIDER',
              status: 'SUCCEEDED',
              code: 'MANUAL_FOLLOW_UP_REQUIRED',
              responseBody: 'private response body',
              redirectUrl: 'https://redirect.example/private',
            }],
            evidence: [{
              id: 'evidence-1',
              kind: 'WEB_SEARCH_PROVIDER',
              sourceUrl: 'https://fixture.example/events/safe',
              observedAt: new Date(),
              contentHash: 'hash-only',
              fields: [],
              basisKey,
              rawBody: 'private response body',
              privateContact: 'person@example.test',
              redirectUrl: 'https://redirect.example/private',
            }],
            fieldSuggestions: [{
              field: 'description',
              value: 'Safe proposed description',
              confidence: 0.9,
              reason: 'Safe fixed reason.',
              evidenceIds: ['evidence-1'],
              basisKey,
              rawValue: 'private source value',
            }],
            retryable: false,
            searchFallback: {
              availability: 'AVAILABLE',
              mode: 'MANUAL_FOLLOW_UP',
              query: 'Public candidate source Kauai',
              href: 'https://search.brave.com/search?q=Public',
            },
            updatedAt: new Date(),
            rawArtifact: 'private artifact',
          },
        },
      });

      assert.deepEqual(docsFrom(publishAs(null, INGESTION_RESEARCH_PUBLICATION)), []);
      assert.deepEqual(docsFrom(publishAs(member, INGESTION_RESEARCH_PUBLICATION)), []);
      const document = docsFrom(publishAs(admin, INGESTION_RESEARCH_PUBLICATION))[0];
      assert.equal(document.research.status, 'PARTIAL');
      assert.equal(document.research.evidence[0].sourceUrl, 'https://fixture.example/events/safe');
      assert.equal(document.research.searchFallback.mode, 'MANUAL_FOLLOW_UP');
      assert.equal(document.research.retryable, false);
      const serialized = JSON.stringify(document);
      [
        'private response body',
        'redirect.example',
        'person@example.test',
        'private-fingerprint',
        'private source value',
        'private artifact',
      ].forEach(value => assert.notInclude(serialized, value));
    });

    it('uses a conservative named rate limit for research requests', function () {
      assert.deepEqual(rateLimitFor(INGESTION_RESEARCH_METHODS.request), [5, 60]);
    });

    it('publishes lease-based worker health without process or connection details', function () {
      const admin = makeUser({ admin: true });
      const member = makeUser();
      const heartbeatAt = new Date();
      IngestionWorkerHealth.insert({
        _id: 'worker:opaque-fixture-id',
        contractVersion: 'ingestion-worker-health.v1',
        status: 'ONLINE',
        startedAt: heartbeatAt,
        heartbeatAt,
        leaseUntil: new Date(heartbeatAt.getTime() + 20_000),
        processed: 4,
        currentRequestId: 'request-1',
        currentSourceId: 'SRC-901',
        currentCandidateId: 'candidate_research_1',
        currentExecutionMode: 'RESEARCH',
        mongoUrl: 'mongodb://private.example/database',
        processEnvironment: { SECRET: 'private' },
      });

      assert.deepEqual(docsFrom(publishAs(null, INGESTION_WORKER_HEALTH_PUBLICATION)), []);
      assert.deepEqual(docsFrom(publishAs(member, INGESTION_WORKER_HEALTH_PUBLICATION)), []);
      const document = docsFrom(publishAs(admin, INGESTION_WORKER_HEALTH_PUBLICATION))[0];
      assert.equal(document.status, 'ONLINE');
      assert.equal(document.currentCandidateId, 'candidate_research_1');
      assert.equal(document.leaseUntil.getTime(), heartbeatAt.getTime() + 20_000);
      assert.notProperty(document, 'mongoUrl');
      assert.notProperty(document, 'processEnvironment');
    });
  });
}
