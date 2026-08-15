/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import {
  CommunitySources,
  INGESTION_PUBLICATIONS,
  IngestionCandidates,
  SourceHealth,
  SourceRuns,
} from './IngestionData';
import { makeUser } from '../../startup/server/testFixtures';
import '../../startup/server/CommunityIngestion';

const publishAs = (userId, name) => {
  const handler = Meteor.server.publish_handlers[name];
  if (!handler) throw new Error(`No such publication: ${name}`);
  return handler.apply({ userId, ready: () => null, onStop: () => {} }, []);
};

const docsFrom = cursor => (cursor && typeof cursor.fetch === 'function' ? cursor.fetch() : []);

if (Meteor.isServer) {
  describe('community ingestion publications', function () {
    this.timeout(10000);

    beforeEach(function () {
      CommunitySources.remove({});
      SourceRuns.remove({});
      IngestionCandidates.remove({});
      SourceHealth.remove({});

      CommunitySources.insert({
        _id: 'SRC-TEST',
        id: 'SRC-TEST',
        displayName: 'Test Source',
        slug: 'test-source',
        tier: 'A',
        adapterKind: 'SYNTHETIC_FIXTURE',
        permission: 'PROBE_REQUIRED',
        enabled: false,
        steward: 'test steward',
        lastVerifiedAt: new Date(),
        endpoints: [{ urlTemplate: 'https://private.example/events' }],
        httpPolicy: { allowedHosts: ['private.example'] },
        adapterConfig: { kind: 'SYNTHETIC_FIXTURE' },
      });
      SourceRuns.insert({
        _id: 'run-test',
        sourceId: 'SRC-TEST',
        status: 'FAILED',
        errorCode: 'PARSER_SCHEMA_DRIFT',
        error: { message: 'raw upstream detail must remain private' },
        startedAt: new Date(),
      });
      IngestionCandidates.insert({
        _id: 'candidate-test',
        sourceId: 'SRC-TEST',
        observationId: 'observation-test',
        summary: { title: 'A reviewable event' },
        validationState: 'VALID',
        reviewStatus: 'APPROVED',
        publicationState: 'FAILED',
        approvalClaimedAt: new Date(),
        lastProjectionErrorCode: 'test-interrupted-publication',
        createdAt: new Date(),
        entityHint: 'event',
        sourceItemKey: 'event:test-event',
        recurringSeriesKey: 'series:v1:test',
        classificationSuggestion: {
          taxonomyVersion: 'matchbook-topics.v1',
          topicKey: 'community',
          subcategoryKey: 'cultural_community',
          confidence: 0.8,
          reasons: ['TITLE_MATCH'],
        },
        editorialOverrides: {
          title: 'Reviewed public title',
          location: 'Reviewed public venue',
          schedule: {
            kind: 'ONE_TIME',
            localStart: '2026-08-18T18:00:00',
            localEnd: '2026-08-18T19:00:00',
            privateNote: 'must not publish',
          },
          privateNote: 'must not publish',
        },
        editorialRevision: 2,
        editorialEditToken: 'edit:test-safe-token',
        editorialUpdatedAt: new Date(),
        editorialUpdatedBy: 'private-editor-id',
        lastEditorialAuditId: 'private-audit-id',
        normalizedFields: {
          title: 'A reviewable event',
          location: 'Public venue',
          recurrenceLabel: 'Every Monday at 5:00pm',
          description: 'internal normalized content',
          reviewDescription: 'A privacy-safe description for human review.',
          context: 'The official listing identifies this as a community writing workshop.',
          locationHint: 'The church named in the official listing',
          researchNeeded: ['location'],
          reviewContextVersion: 'safe-review.v1',
          internalScoringNote: 'not for the browser',
        },
        rawFields: { contactEmail: 'private@example.test' },
        evidence: [{ excerpt: 'private evidence excerpt' }],
      });
      SourceHealth.insert({
        _id: 'SRC-TEST',
        sourceId: 'SRC-TEST',
        lastStatus: 'FAILED',
        lastErrorCode: 'PARSER_SCHEMA_DRIFT',
        consecutiveFailures: 1,
        rawDiagnostic: 'private response detail',
      });
    });

    afterEach(function () {
      CommunitySources.remove({ _id: 'SRC-TEST' });
      SourceRuns.remove({ _id: 'run-test' });
      IngestionCandidates.remove({ _id: 'candidate-test' });
      SourceHealth.remove({ _id: 'SRC-TEST' });
    });

    it('sends no ingestion data to anonymous or ordinary users', function () {
      const ordinaryUser = makeUser();
      Object.values(INGESTION_PUBLICATIONS).forEach(name => {
        assert.deepEqual(docsFrom(publishAs(null, name)), [], `${name} denied anonymously`);
        assert.deepEqual(docsFrom(publishAs(ordinaryUser, name)), [], `${name} denied to members`);
      });
    });

    it('gives administrators only the explicit sanitized projections', function () {
      const admin = makeUser({ admin: true });
      const source = docsFrom(publishAs(admin, INGESTION_PUBLICATIONS.sources))[0];
      const run = docsFrom(publishAs(admin, INGESTION_PUBLICATIONS.runs))[0];
      const candidate = docsFrom(publishAs(admin, INGESTION_PUBLICATIONS.candidates))[0];
      const health = docsFrom(publishAs(admin, INGESTION_PUBLICATIONS.health))[0];

      assert.equal(source.displayName, 'Test Source');
      ['endpoints', 'httpPolicy', 'adapterConfig'].forEach(field => assert.notProperty(source, field));

      assert.equal(run.errorCode, 'PARSER_SCHEMA_DRIFT');
      assert.notProperty(run, 'error');

      assert.equal(candidate.summary.title, 'A reviewable event');
      assert.equal(candidate.entityHint, 'event');
      assert.equal(candidate.sourceItemKey, 'event:test-event');
      assert.equal(candidate.observationId, 'observation-test');
      assert.equal(candidate.recurringSeriesKey, 'series:v1:test');
      assert.deepInclude(candidate.classificationSuggestion, {
        topicKey: 'community',
        subcategoryKey: 'cultural_community',
      });
      assert.equal(candidate.normalizedFields.title, 'A reviewable event');
      assert.equal(candidate.normalizedFields.location, 'Public venue');
      assert.equal(candidate.normalizedFields.recurrenceLabel, 'Every Monday at 5:00pm');
      assert.equal(
        candidate.normalizedFields.reviewDescription,
        'A privacy-safe description for human review.',
      );
      assert.equal(
        candidate.normalizedFields.context,
        'The official listing identifies this as a community writing workshop.',
      );
      assert.equal(candidate.normalizedFields.locationHint, 'The church named in the official listing');
      assert.deepEqual(candidate.normalizedFields.researchNeeded, ['location']);
      assert.equal(candidate.normalizedFields.reviewContextVersion, 'safe-review.v1');
      assert.equal(candidate.publicationState, 'FAILED');
      assert.equal(candidate.lastProjectionErrorCode, 'test-interrupted-publication');
      assert.instanceOf(candidate.approvalClaimedAt, Date);
      assert.deepEqual(candidate.editorialOverrides, {
        title: 'Reviewed public title',
        location: 'Reviewed public venue',
        schedule: {
          kind: 'ONE_TIME',
          localStart: '2026-08-18T18:00:00',
          localEnd: '2026-08-18T19:00:00',
        },
      });
      assert.equal(candidate.editorialRevision, 2);
      assert.equal(candidate.editorialEditToken, 'edit:test-safe-token');
      assert.instanceOf(candidate.editorialUpdatedAt, Date);
      assert.notProperty(candidate, 'editorialUpdatedBy');
      assert.notProperty(candidate, 'lastEditorialAuditId');
      ['description', 'internalScoringNote'].forEach(field => (
        assert.notProperty(candidate.normalizedFields, field)
      ));
      ['rawFields', 'evidence'].forEach(field => assert.notProperty(candidate, field));

      assert.equal(health.lastErrorCode, 'PARSER_SCHEMA_DRIFT');
      assert.notProperty(health, 'rawDiagnostic');
    });

    it('defines no publication for raw artifacts or observations', function () {
      assert.isUndefined(Meteor.server.publish_handlers['ingestion.artifacts.admin']);
      assert.isUndefined(Meteor.server.publish_handlers['ingestion.observations.admin']);
    });
  });
}
