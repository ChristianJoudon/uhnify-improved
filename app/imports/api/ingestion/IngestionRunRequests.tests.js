/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Profiles } from '../profiles/Profiles';
import {
  CommunitySources,
  SourceHealth,
} from './IngestionData';
import {
  claimableIngestionRunRequestSelector,
  INGESTION_RECENT_POLICY,
  INGESTION_RUN_ACTIVE_GUARD,
  INGESTION_RUN_EXECUTION_MODE,
  INGESTION_RUN_REQUEST_METHODS,
  INGESTION_RUN_REQUEST_PUBLICATION,
  INGESTION_RUN_REQUEST_STATUS,
  IngestionRunRequests,
} from './IngestionRunRequests';
import {
  ensureIngestionRunRequestIndexes,
} from '../../startup/server/CommunityIngestionRunQueue';
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

const addSource = sourceId => CommunitySources.insert({
  _id: sourceId,
  id: sourceId,
  slug: sourceId.toLowerCase(),
  displayName: `Source ${sourceId}`,
});

const clean = () => {
  IngestionRunRequests.remove({});
  CommunitySources.remove({});
  SourceHealth.remove({});
  Meteor.roleAssignment.remove({});
  Meteor.users.remove({});
  Profiles.collection.remove({});
};

if (Meteor.isServer) {
  describe('community ingestion run-request queue', function () {
    this.timeout(10000);

    before(async function () {
      clean();
      await ensureIngestionRunRequestIndexes();
    });

    beforeEach(function () {
      clean();
    });

    after(function () {
      clean();
    });

    it('allows only administrators to enqueue source work', function () {
      addSource('SRC-901');
      const member = makeUser();

      assert.equal(
        errorFrom(() => callAs(null, INGESTION_RUN_REQUEST_METHODS.requestSource, 'SRC-901', 'RERUN')),
        'not-logged-in',
      );
      assert.equal(
        errorFrom(() => callAs(member, INGESTION_RUN_REQUEST_METHODS.requestSource, 'SRC-901', 'RERUN')),
        'not-authorized',
      );
      assert.equal(IngestionRunRequests.find().count(), 0);
    });

    it('accepts only registered source ids, never browser-supplied execution details', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');

      assert.equal(
        errorFrom(() => callAs(
          admin,
          INGESTION_RUN_REQUEST_METHODS.requestSource,
          'https://example.test/events?command=run',
          'RERUN',
        )),
        'invalid-source-id',
      );
      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_RUN_REQUEST_METHODS.requestSource, 'SRC-999', 'RERUN')),
        'source-not-found',
      );
      assert.match(
        String(errorFrom(() => callAs(
          admin,
          INGESTION_RUN_REQUEST_METHODS.requestSource,
          { sourceId: 'SRC-901', command: 'run arbitrary process' },
          'RERUN',
        ))),
        /Match error|Expected string/i,
      );
      assert.equal(IngestionRunRequests.find().count(), 0);
    });

    it('derives PRACTICE and MANUAL modes from registered source namespaces', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');
      addSource('SEN-901');

      const practice = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );
      const manual = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SEN-901',
        INGESTION_RECENT_POLICY.rerun,
      );

      assert.notInstanceOf(practice, Promise, 'the method contract stays synchronous');
      assert.equal(practice.requests[0].executionMode, INGESTION_RUN_EXECUTION_MODE.practice);
      assert.equal(manual.requests[0].executionMode, INGESTION_RUN_EXECUTION_MODE.manual);
      assert.equal(practice.requests[0].status, INGESTION_RUN_REQUEST_STATUS.queued);
      assert.equal(manual.requests[0].status, INGESTION_RUN_REQUEST_STATUS.queued);

      const stored = IngestionRunRequests.findOne(practice.requests[0].requestId);
      assert.equal(stored.attempts, 0);
      assert.equal(stored.activeGuard, INGESTION_RUN_ACTIVE_GUARD);
      ['url', 'command', 'adapter', 'artifactPath'].forEach(field => assert.notProperty(stored, field));
    });

    it('recomputes the 24-hour guard on the server and honors explicit RERUN', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');
      const lastAttemptAt = new Date(Date.now() - (2 * 60 * 60 * 1000));
      SourceHealth.insert({
        _id: 'SRC-901',
        sourceId: 'SRC-901',
        lastAttemptAt,
        lastStatus: 'COMPLETE',
      });

      const skipped = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.skip,
      );
      assert.equal(skipped.requests[0].status, INGESTION_RUN_REQUEST_STATUS.skippedRecent);
      assert.equal(skipped.totals.skippedRecent, 1);
      assert.closeTo(skipped.requests[0].lastAttemptAt.getTime(), lastAttemptAt.getTime(), 1);
      assert.notProperty(IngestionRunRequests.findOne(skipped.requests[0].requestId), 'activeGuard');

      const rerun = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );
      assert.equal(rerun.requests[0].status, INGESTION_RUN_REQUEST_STATUS.queued);
      assert.equal(rerun.totals.queued, 1);
    });

    it('creates one request per source in an all-source batch', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');
      addSource('SEN-901');
      SourceHealth.insert({
        _id: 'SEN-901',
        sourceId: 'SEN-901',
        lastAttemptAt: new Date(Date.now() - 1000),
        lastStatus: 'COMPLETE',
      });

      const result = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestAll,
        INGESTION_RECENT_POLICY.skip,
      );

      assert.deepEqual(result.totals, {
        requested: 2,
        queued: 1,
        skippedRecent: 1,
        alreadyRunning: 0,
      });
      assert.deepEqual(result.requests.map(request => request.sourceId), ['SEN-901', 'SRC-901'].sort());
      assert.equal(IngestionRunRequests.find({ batchId: result.batchId }).count(), 2);
      assert.equal(new Set(result.requests.map(request => request.sourceId)).size, 2);
    });

    it('atomically keeps one active request per source and audits duplicate clicks', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');

      const first = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );
      const second = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );

      assert.equal(first.requests[0].status, INGESTION_RUN_REQUEST_STATUS.queued);
      assert.equal(second.requests[0].status, INGESTION_RUN_REQUEST_STATUS.alreadyRunning);
      assert.equal(second.requests[0].activeRequestId, first.requests[0].requestId);
      assert.equal(IngestionRunRequests.find({
        sourceId: 'SRC-901',
        activeGuard: INGESTION_RUN_ACTIVE_GUARD,
      }).count(), 1);
      assert.equal(IngestionRunRequests.find({ sourceId: 'SRC-901' }).count(), 2);
    });

    it('leaves expired RUNNING leases reclaimable without opening a second request', function () {
      const admin = makeUser({ admin: true });
      addSource('SRC-901');
      const first = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );
      const expiredAt = new Date(Date.now() - 1000);
      IngestionRunRequests.update(first.requests[0].requestId, {
        $set: {
          status: INGESTION_RUN_REQUEST_STATUS.running,
          leaseOwner: 'worker-before-restart',
          leaseToken: 'expired-token',
          leaseUntil: expiredAt,
        },
      });

      assert.equal(IngestionRunRequests.find(
        claimableIngestionRunRequestSelector(new Date()),
      ).count(), 1, 'an expired lease is available for atomic reclaim');

      const duplicate = callAs(
        admin,
        INGESTION_RUN_REQUEST_METHODS.requestSource,
        'SRC-901',
        INGESTION_RECENT_POLICY.rerun,
      );
      assert.equal(duplicate.requests[0].status, INGESTION_RUN_REQUEST_STATUS.alreadyRunning);
      assert.equal(duplicate.requests[0].activeRequestId, first.requests[0].requestId);

      IngestionRunRequests.update(first.requests[0].requestId, {
        $set: { leaseUntil: new Date(Date.now() + 60 * 1000) },
      });
      assert.equal(IngestionRunRequests.find(
        claimableIngestionRunRequestSelector(new Date()),
      ).count(), 0, 'a live lease is not reclaimable');
    });

    it('publishes only a sanitized queue projection to administrators', function () {
      const admin = makeUser({ admin: true });
      const member = makeUser();
      IngestionRunRequests.insert({
        _id: 'request-private-test',
        batchId: 'batch-private-test',
        sourceId: 'SRC-901',
        executionMode: 'PRACTICE',
        requestScope: 'SOURCE',
        recentPolicy: 'RERUN',
        status: 'RUNNING',
        requestedAt: new Date(),
        requestedBy: admin,
        activeGuard: 'ACTIVE',
        attempts: 1,
        leaseOwner: 'private-worker-hostname',
        leaseToken: 'private-lease-token',
        workerDiagnostic: 'private parser detail',
        command: 'private command detail',
      });

      assert.deepEqual(docsFrom(publishAs(null, INGESTION_RUN_REQUEST_PUBLICATION)), []);
      assert.deepEqual(docsFrom(publishAs(member, INGESTION_RUN_REQUEST_PUBLICATION)), []);

      const request = docsFrom(publishAs(admin, INGESTION_RUN_REQUEST_PUBLICATION))[0];
      assert.equal(request.sourceId, 'SRC-901');
      assert.equal(request.status, 'RUNNING');
      [
        'requestedBy',
        'activeGuard',
        'leaseOwner',
        'leaseToken',
        'workerDiagnostic',
        'command',
      ].forEach(field => assert.notProperty(request, field));
    });
  });
}
