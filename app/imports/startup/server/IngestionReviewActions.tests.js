/* eslint-env mocha */
import crypto from 'crypto';
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { Counters } from '../../api/counters/Counters';
import {
  CommunitySources,
  IngestionCandidates,
} from '../../api/ingestion/IngestionData';
import {
  ReviewItems,
  SourceEntityKeys,
  SourceObservations,
  SourcePolicyAssessments,
} from '../../api/ingestion/server/IngestionPersistence';
import {
  approveCandidate,
  approveCandidateBatch,
  approveCandidateSeries,
  clearCandidatesFromReview,
  expandSupportRecurrence,
  ingestionPromotionCutoff,
  INGESTION_REVIEW_METHODS,
  previewCandidates,
  reopenClearedCandidates,
  saveCandidateEditorialOverrides,
} from './IngestionReviewActions';
import {
  callAs,
  errorFrom,
  makeClub,
  makeEvent,
  makeUser,
  resetAll,
} from './testFixtures';

const SOURCE_URLS = Object.freeze({
  'SEN-001': 'https://kauaimeetings.com/locations/',
  'SEN-005': 'https://www.alz.org/hawaii/support',
});

const addSource = ({
  sourceId = 'SEN-001',
  permission = 'MANUAL_ONLY',
  policyStatus = 'MANUAL_INTAKE_APPROVED',
} = {}) => {
  const publisherUrl = SOURCE_URLS[sourceId] || 'https://events.example.test/';
  CommunitySources.insert({
    _id: sourceId,
    id: sourceId,
    sourceId,
    slug: `source-${sourceId.toLowerCase()}`,
    displayName: `Source ${sourceId}`,
    publisherName: `Publisher ${sourceId}`,
    publisherUrl,
    permission,
  });
  if (sourceId.startsWith('SEN-')) {
    SourcePolicyAssessments.insert({
      _id: `${sourceId}:test-policy`,
      sourceId,
      revision: 1,
      policyStatus,
    });
  }
  return publisherUrl;
};

let sequence = 0;

const addCandidate = ({
  kind = 'group',
  sourceId = 'SEN-001',
  groupKey = 'sample-group',
  itemKey,
  fields = {},
  candidateFields = {},
  observationFields,
  status = 'PENDING',
} = {}) => {
  sequence += 1;
  const sourceItemKey = itemKey || (kind === 'group'
    ? `group:${groupKey}`
    : `event:${groupKey}-slot-${sequence}`);
  const observationId = `observation-${sequence}`;
  const candidateId = `candidate-${sequence}`;
  const sourceUrl = SOURCE_URLS[sourceId] || 'https://events.example.test/';
  const normalizedFields = kind === 'group' ? {
    title: 'Sample Support Group',
    listingType: 'support_group',
    supportSubtype: 'addiction_recovery',
    recurrenceLabels: ['Monday at noon'],
    locationLabels: ['Līhuʻe Civic Center'],
    formatLabels: ['Open'],
    sourceUrl,
    verifiedAt: '2026-08-08T12:00:00-10:00',
    reviewFlags: ['MANUAL_SOURCE_CAPTURE'],
    ...fields,
  } : {
    title: 'Sample Support Group',
    listingType: 'support_group',
    supportSubtype: 'addiction_recovery',
    recurrenceLabel: 'Monday at noon',
    timeZone: 'Pacific/Honolulu',
    location: 'Līhuʻe Civic Center',
    formatLabels: ['Open'],
    sourceUrl,
    verifiedAt: '2026-08-08T12:00:00-10:00',
    reviewFlags: ['MANUAL_SOURCE_CAPTURE'],
    realityStatus: 'SCHEDULED',
    ...fields,
  };

  SourceObservations.insert({
    _id: observationId,
    sourceId,
    sourceItemKey,
    entityHint: kind,
    canonicalSourceUrl: sourceUrl,
    rawFields: observationFields || { groupKey },
    itemContentHash: candidateId,
    parserVersion: 'test.v1',
  });
  IngestionCandidates.insert({
    _id: candidateId,
    sourceId,
    sourceItemKey,
    observationId,
    fingerprint: candidateId,
    normalizedFields,
    summary: { title: normalizedFields.title },
    validationState: 'VALID',
    reviewStatus: status,
    reviewLane: 'SENSITIVE',
    privacyReviewRequired: true,
    projectionEligibility: 'REQUIRES_SENSITIVE_REVIEW',
    createdAt: new Date(Date.now() + sequence),
    ...candidateFields,
  });
  return candidateId;
};

if (Meteor.isServer) {
  describe('ingestion candidate review projection', function () {
    this.timeout(15000);

    let admin;
    let member;
    let originalSandboxSetting;

    before(function () {
      Meteor.settings.public = Meteor.settings.public || {};
      originalSandboxSetting = Meteor.settings.public.communityIngestionSandbox;
    });

    beforeEach(function () {
      resetAll();
      Counters.collection.remove({});
      CommunitySources.remove({});
      IngestionCandidates.remove({});
      ReviewItems.remove({});
      SourceEntityKeys.remove({});
      SourceObservations.remove({});
      SourcePolicyAssessments.remove({});
      admin = makeUser({ admin: true });
      member = makeUser();
      addSource();
      Meteor.settings.public.communityIngestionSandbox = false;
    });

    afterEach(function () {
      CommunitySources.remove({});
      IngestionCandidates.remove({});
      ReviewItems.remove({});
      SourceEntityKeys.remove({});
      SourceObservations.remove({});
      SourcePolicyAssessments.remove({});
    });

    after(function () {
      if (originalSandboxSetting === undefined) {
        delete Meteor.settings.public.communityIngestionSandbox;
      } else {
        Meteor.settings.public.communityIngestionSandbox = originalSandboxSetting;
      }
    });

    it('expands the protected weekly and monthly schedule grammar in Hawaii time', function () {
      const from = new Date('2026-08-09T22:30:00.000Z'); // Sunday 12:30 PM HST.
      const weekly = expandSupportRecurrence('Monday at noon', from);
      const ranged = expandSupportRecurrence('Every Tuesday, 1:30 pm–3:00 pm', from);
      const second = expandSupportRecurrence('Second Wednesday of the month, 6:00 pm–7:30 pm', from);
      const last = expandSupportRecurrence('Last Saturday of the month, 11:00 am–12:30 pm', from);

      assert.lengthOf(weekly, 6);
      assert.equal(weekly[0].start.toISOString(), '2026-08-10T22:00:00.000Z');
      assert.equal(ranged[0].start.toISOString(), '2026-08-11T23:30:00.000Z');
      assert.equal(ranged[0].end.toISOString(), '2026-08-12T01:00:00.000Z');
      assert.equal(second[0].start.toISOString(), '2026-08-13T04:00:00.000Z');
      assert.equal(last[0].start.toISOString(), '2026-08-29T21:00:00.000Z');
      assert.equal(
        errorFrom(() => expandSupportRecurrence('sometimes in the evening', from)),
        'ingestion-unsupported-recurrence',
      );
    });

    it('requires an administrator and approves a group idempotently', function () {
      const candidateId = addCandidate();
      assert.equal(
        errorFrom(() => callAs(null, INGESTION_REVIEW_METHODS.approve, candidateId)),
        'not-logged-in',
      );
      assert.equal(
        errorFrom(() => callAs(member, INGESTION_REVIEW_METHODS.approve, candidateId)),
        'not-authorized',
      );

      const first = callAs(admin, INGESTION_REVIEW_METHODS.approve, candidateId);
      const second = callAs(admin, INGESTION_REVIEW_METHODS.approve, candidateId);
      const club = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });

      assert.equal(first.outcome, 'APPROVED');
      assert.equal(second.outcome, 'ALREADY_APPROVED');
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(club.clubID, Clubs.collection.findOne(club._id).clubID);
      assert.deepEqual(club.categories, ['support_group']);
      assert.equal(club.owner, 'MatchBook community intake');
      assert.notProperty(club, 'phone');
      assert.notProperty(club, 'email');
      assert.equal(IngestionCandidates.findOne(candidateId).reviewStatus, 'APPROVED');
      assert.equal(IngestionCandidates.findOne(candidateId).publicationState, 'COMPLETE');
      assert.equal(ReviewItems.findOne(`approval:${candidateId}`).status, 'APPROVED');
      assert.equal(ReviewItems.findOne(`approval:${candidateId}`).publicationState, 'COMPLETE');
    });

    it('clears and reopens pending review candidates without deleting evidence or publishing', function () {
      const at = new Date('2026-08-10T18:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'clear-review' });
      const candidateBefore = IngestionCandidates.findOne(candidateId);
      const observationBefore = SourceObservations.findOne(candidateBefore.observationId);

      assert.equal(
        errorFrom(() => callAs(
          member,
          INGESTION_REVIEW_METHODS.clear,
          [candidateId],
          'REVIEWED_SKIP',
        )),
        'not-authorized',
      );
      const cleared = clearCandidatesFromReview(
        [candidateId],
        admin,
        'REVIEWED_SKIP',
        at,
      );
      const clearedCandidate = IngestionCandidates.findOne(candidateId);
      const clearDecision = ReviewItems.findOne({ candidateId, decision: 'CLEAR_CANDIDATE' });

      assert.equal(cleared.changed, 1);
      assert.equal(clearedCandidate.reviewStatus, 'REJECTED');
      assert.equal(clearedCandidate.clearReason, 'REVIEWED_SKIP');
      assert.equal(clearedCandidate.reviewDispositionRevision, 1);
      assert.equal(clearDecision.status, 'COMPLETE');
      assert.equal(clearDecision.fromStatus, 'PENDING');
      assert.equal(clearDecision.toStatus, 'REJECTED');
      assert.deepEqual(SourceObservations.findOne(candidateBefore.observationId), observationBefore);
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);

      const replay = clearCandidatesFromReview([candidateId], admin, 'REVIEWED_SKIP', at);
      assert.equal(replay.changed, 0);
      assert.equal(replay.alreadyInState, 1);
      assert.equal(ReviewItems.find({ candidateId, decision: 'CLEAR_CANDIDATE' }).count(), 1);

      const reopened = reopenClearedCandidates(
        [candidateId],
        admin,
        new Date('2026-08-10T18:01:00.000Z'),
      );
      const reopenedCandidate = IngestionCandidates.findOne(candidateId);
      const reopenDecision = ReviewItems.findOne({ candidateId, decision: 'REOPEN_CANDIDATE' });
      assert.equal(reopened.changed, 1);
      assert.equal(reopenedCandidate.reviewStatus, 'PENDING');
      assert.equal(reopenedCandidate.reviewDispositionRevision, 2);
      assert.notProperty(reopenedCandidate, 'clearedAt');
      assert.notProperty(reopenedCandidate, 'clearReason');
      assert.equal(reopenDecision.status, 'COMPLETE');
      assert.deepEqual(SourceObservations.findOne(candidateBefore.observationId), observationBefore);
    });

    it('clears only pending latest revisions and records an explicit outside-window reason', function () {
      const at = new Date('2026-08-10T18:00:00.000Z');
      const pendingId = addCandidate({ groupKey: 'outside-clear' });
      const approvedId = addCandidate({ groupKey: 'already-approved', status: 'APPROVED' });
      const publishedClubId = makeClub({ name: 'Published group must remain unchanged' });
      const publishedEventId = makeEvent({ title: 'Published event must remain unchanged' });
      const publishedClubBefore = Clubs.collection.findOne(publishedClubId);
      const publishedEventBefore = Events.collection.findOne(publishedEventId);
      const result = clearCandidatesFromReview(
        [pendingId, approvedId, 'missing-candidate'],
        admin,
        'OUTSIDE_REVIEW_WINDOW',
        at,
      );

      assert.equal(result.requested, 3);
      assert.equal(result.changed, 1);
      assert.equal(result.skipped, 2);
      assert.equal(IngestionCandidates.findOne(pendingId).reviewStatus, 'REJECTED');
      assert.equal(IngestionCandidates.findOne(pendingId).clearReason, 'OUTSIDE_REVIEW_WINDOW');
      assert.equal(IngestionCandidates.findOne(approvedId).reviewStatus, 'APPROVED');
      assert.equal(ReviewItems.findOne({ candidateId: pendingId, decision: 'CLEAR_CANDIDATE' }).reason, 'OUTSIDE_REVIEW_WINDOW');
      assert.deepEqual(Clubs.collection.findOne(publishedClubId), publishedClubBefore);
      assert.deepEqual(Events.collection.findOne(publishedEventId), publishedEventBefore);
    });

    it('keeps concurrent clear attempts in separate audit rows and preserves the winning decision', function () {
      const at = new Date('2026-08-10T18:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'concurrent-clear' });
      const originalUpdate = IngestionCandidates.update;
      let nestedResult;
      let intercepted = false;

      IngestionCandidates.update = function (...args) {
        const [selector, modifier] = args;
        if (!intercepted
            && `${selector?._id}` === candidateId
            && modifier?.$set?.reviewStatus === 'REJECTED') {
          intercepted = true;
          nestedResult = clearCandidatesFromReview(
            [candidateId],
            admin,
            'REVIEWED_SKIP',
            at,
          );
        }
        return originalUpdate.apply(this, args);
      };

      let outerResult;
      try {
        outerResult = clearCandidatesFromReview(
          [candidateId],
          admin,
          'REVIEWED_SKIP',
          at,
        );
      } finally {
        IngestionCandidates.update = originalUpdate;
      }

      const decisions = ReviewItems.find({
        candidateId,
        decision: 'CLEAR_CANDIDATE',
      }).fetch();
      const completeDecision = decisions.find(decision => decision.status === 'COMPLETE');
      const candidate = IngestionCandidates.findOne(candidateId);

      assert.equal(nestedResult.changed, 1);
      assert.equal(outerResult.changed, 0);
      assert.equal(outerResult.skipped, 1);
      assert.lengthOf(decisions, 2);
      assert.lengthOf(decisions.filter(decision => decision.status === 'COMPLETE'), 1);
      assert.lengthOf(decisions.filter(decision => decision.status === 'CONFLICT'), 1);
      assert.equal(candidate.reviewStatus, 'REJECTED');
      assert.equal(candidate.lastReviewDispositionActionId, completeDecision._id);

      const replay = clearCandidatesFromReview(
        [candidateId],
        admin,
        'REVIEWED_SKIP',
        at,
      );
      assert.equal(replay.changed, 0);
      assert.equal(replay.alreadyInState, 1);
      assert.equal(ReviewItems.find({ candidateId, decision: 'CLEAR_CANDIDATE' }).count(), 2);
    });

    it('records both approval barriers before replacing an existing live revision', function () {
      const firstId = addCandidate({
        groupKey: 'revision-test',
        fields: { title: 'Original Published Name' },
      });
      callAs(admin, INGESTION_REVIEW_METHODS.approve, firstId);
      const originalClub = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      const secondId = addCandidate({
        groupKey: 'revision-test',
        fields: { title: 'Reviewed Replacement Name' },
      });
      const originalUpsert = Clubs.collection.upsert;
      let barrierObserved = false;

      Clubs.collection.upsert = function (...args) {
        const candidate = IngestionCandidates.findOne(secondId);
        const decision = ReviewItems.findOne(`approval:${secondId}`);
        const stillLive = Clubs.collection.findOne(originalClub._id);
        assert.equal(candidate.reviewStatus, 'APPROVED');
        assert.equal(candidate.publicationState, 'APPLYING');
        assert.equal(decision.status, 'APPROVED');
        assert.equal(decision.decision, 'APPROVE');
        assert.equal(stillLive.publicationStatus, 'published');
        assert.equal(stillLive.name, 'Original Published Name');
        barrierObserved = true;
        return originalUpsert.apply(this, args);
      };

      try {
        const result = callAs(admin, INGESTION_REVIEW_METHODS.approve, secondId);
        assert.equal(result.outcome, 'APPROVED');
      } finally {
        Clubs.collection.upsert = originalUpsert;
      }

      assert.isTrue(barrierObserved);
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(Clubs.collection.findOne(originalClub._id).name, 'Reviewed Replacement Name');
      assert.equal(IngestionCandidates.findOne(secondId).publicationState, 'COMPLETE');
    });

    it('recovers a stale approval claim before publishing idempotently', function () {
      const candidateId = addCandidate();
      IngestionCandidates.update(candidateId, {
        $set: {
          reviewStatus: 'APPROVING',
          approvalClaimToken: 'worker-that-stopped',
          approvalClaimedAt: new Date(Date.now() - (10 * 60 * 1000)),
          approvalClaimedBy: admin,
        },
      });

      const result = callAs(admin, INGESTION_REVIEW_METHODS.approve, candidateId);

      assert.equal(result.outcome, 'APPROVED');
      assert.equal(IngestionCandidates.findOne(candidateId).reviewStatus, 'APPROVED');
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(ReviewItems.find({ candidateId }).count(), 1);
    });

    it('repairs an interrupted approved publication without duplicating occurrences', function () {
      const at = new Date('2026-08-09T22:30:00.000Z');
      const groupId = addCandidate({ kind: 'group', groupKey: 'repair-test' });
      approveCandidate(groupId, admin, at);
      const eventId = addCandidate({ kind: 'event', groupKey: 'repair-test' });
      const originalUpsert = Events.collection.upsert;
      let eventWrites = 0;

      Events.collection.upsert = function (...args) {
        eventWrites += 1;
        if (eventWrites === 2) {
          throw new Meteor.Error('test-interrupted-publication', 'Simulated worker interruption.');
        }
        return originalUpsert.apply(this, args);
      };

      try {
        assert.equal(
          errorFrom(() => approveCandidate(eventId, admin, at)),
          'test-interrupted-publication',
        );
      } finally {
        Events.collection.upsert = originalUpsert;
      }

      const failed = IngestionCandidates.findOne(eventId);
      const failedDecision = ReviewItems.findOne(`approval:${eventId}`);
      assert.equal(failed.reviewStatus, 'APPROVED');
      assert.equal(failed.publicationState, 'FAILED');
      assert.equal(failedDecision.status, 'APPROVED');
      assert.equal(failedDecision.publicationState, 'FAILED');
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);

      const repaired = approveCandidate(eventId, admin, new Date('2026-09-20T22:30:00.000Z'));
      const club = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      assert.equal(repaired.outcome, 'PUBLICATION_REPAIRED');
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 9);
      assert.equal(EventClubs.collection.find({ clubId: club._id }).count(), 9);
      assert.equal(IngestionCandidates.findOne(eventId).publicationState, 'COMPLETE');
      assert.equal(ReviewItems.findOne(`approval:${eventId}`).publicationState, 'COMPLETE');
    });

    it('takes over a stale approved publication claim and completes it', function () {
      const candidateId = addCandidate({ groupKey: 'stale-publication' });
      const staleAt = new Date(Date.now() - (10 * 60 * 1000));
      IngestionCandidates.update(candidateId, {
        $set: {
          reviewStatus: 'APPROVED',
          publicationState: 'APPLYING',
          approvalClaimToken: 'publisher-that-stopped',
          approvalClaimedAt: staleAt,
          approvalClaimedBy: admin,
          reviewedAt: staleAt,
          reviewedBy: admin,
        },
      });
      ReviewItems.insert({
        _id: `approval:${candidateId}`,
        candidateId,
        status: 'APPROVED',
        decision: 'APPROVE',
        publicationState: 'APPLYING',
        reviewedAt: staleAt,
        reviewedBy: admin,
      });

      const result = callAs(admin, INGESTION_REVIEW_METHODS.approve, candidateId);

      assert.equal(result.outcome, 'PUBLICATION_REPAIRED');
      assert.equal(IngestionCandidates.findOne(candidateId).publicationState, 'COMPLETE');
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
    });

    it('never lets an older failed approval overwrite a completed newer revision', function () {
      const olderId = addCandidate({
        groupKey: 'revision-race',
        fields: { title: 'Older Partially Published Name' },
      });
      const originalMappingUpsert = SourceEntityKeys.upsert;
      SourceEntityKeys.upsert = function (selector, ...args) {
        if (`${selector?._id || ''}`.startsWith('source-key:')) {
          throw new Meteor.Error('test-mapping-interruption', 'Simulated interruption after public upsert.');
        }
        return originalMappingUpsert.call(this, selector, ...args);
      };
      try {
        assert.equal(
          errorFrom(() => callAs(admin, INGESTION_REVIEW_METHODS.approve, olderId)),
          'test-mapping-interruption',
        );
      } finally {
        SourceEntityKeys.upsert = originalMappingUpsert;
      }
      assert.equal(IngestionCandidates.findOne(olderId).publicationState, 'FAILED');
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Older Partially Published Name',
      );

      const newerId = addCandidate({
        groupKey: 'revision-race',
        fields: { title: 'Newer Authoritative Name' },
      });
      const newerResult = callAs(admin, INGESTION_REVIEW_METHODS.approve, newerId);
      assert.equal(newerResult.outcome, 'APPROVED');
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Newer Authoritative Name',
      );

      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_REVIEW_METHODS.approve, olderId)),
        'ingestion-candidate-superseded',
      );
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Newer Authoritative Name',
      );
    });

    it('treats a revived, most-recently observed fingerprint as authoritative', function () {
      const firstObservedAt = new Date('2026-08-09T18:00:00.000Z');
      const secondObservedAt = new Date('2026-08-09T19:00:00.000Z');
      const revivedAt = new Date('2026-08-09T20:00:00.000Z');
      const firstId = addCandidate({
        groupKey: 'content-reversion',
        fields: { title: 'Fingerprint A Current Again' },
      });
      IngestionCandidates.update(firstId, {
        $set: { reviewStatus: 'SUPERSEDED', lastObservedAt: firstObservedAt },
      });
      const secondId = addCandidate({
        groupKey: 'content-reversion',
        fields: { title: 'Fingerprint B Intermediate' },
      });
      IngestionCandidates.update(secondId, { $set: { lastObservedAt: secondObservedAt } });

      const secondResult = approveCandidate(secondId, admin, secondObservedAt);
      assert.equal(secondResult.outcome, 'APPROVED');
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint B Intermediate',
      );

      IngestionCandidates.update(firstId, {
        $set: { reviewStatus: 'PENDING', lastObservedAt: revivedAt },
        $unset: { supersededAt: '' },
      });
      const revivedResult = approveCandidate(firstId, admin, revivedAt);
      assert.equal(revivedResult.outcome, 'APPROVED');
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint A Current Again',
      );

      assert.equal(
        errorFrom(() => approveCandidate(secondId, admin, new Date('2026-08-09T21:00:00.000Z'))),
        'ingestion-candidate-superseded',
      );
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint A Current Again',
      );
    });

    it('reopens a completed fingerprint reobserved while another revision holds the lock', function () {
      const firstObservedAt = new Date('2026-08-09T18:00:00.000Z');
      const secondObservedAt = new Date('2026-08-09T19:00:00.000Z');
      const reobservedAt = new Date('2026-08-09T20:00:00.000Z');
      const firstId = addCandidate({
        groupKey: 'completion-race',
        fields: { title: 'Fingerprint A Reobserved' },
      });
      IngestionCandidates.update(firstId, { $set: { lastObservedAt: firstObservedAt } });
      approveCandidate(firstId, admin, firstObservedAt);
      IngestionCandidates.update(firstId, {
        $set: {
          approvalClaimToken: 'stale-completed-claim',
          approvalClaimedAt: firstObservedAt,
          approvalClaimedBy: admin,
          lastProjectionErrorCode: 'stale-completed-error',
        },
      });

      const secondId = addCandidate({
        groupKey: 'completion-race',
        fields: { title: 'Fingerprint B Approved Under Lock' },
      });
      IngestionCandidates.update(secondId, { $set: { lastObservedAt: secondObservedAt } });
      const originalUpsert = Clubs.collection.upsert;
      const originalCandidateUpdate = IngestionCandidates.update;
      let reobservedDuringProjection = false;
      let reopenedBeforeCompletion = false;
      Clubs.collection.upsert = function (...args) {
        if (!reobservedDuringProjection) {
          IngestionCandidates.update(firstId, { $set: { lastObservedAt: reobservedAt } });
          reobservedDuringProjection = true;
        }
        return originalUpsert.apply(this, args);
      };
      IngestionCandidates.update = function (selector, modifier, ...args) {
        if (`${selector?._id || ''}` === firstId && modifier?.$set?.reviewStatus === 'PENDING') {
          const projecting = IngestionCandidates.findOne(secondId);
          const projectingDecision = ReviewItems.findOne(`approval:${secondId}`);
          assert.equal(projecting.reviewStatus, 'APPROVED');
          assert.equal(projecting.publicationState, 'APPLYING');
          assert.equal(projectingDecision.status, 'APPROVED');
          assert.equal(projectingDecision.publicationState, 'APPLYING');
          reopenedBeforeCompletion = true;
        }
        return originalCandidateUpdate.call(this, selector, modifier, ...args);
      };

      try {
        const result = approveCandidate(secondId, admin, secondObservedAt);
        assert.equal(result.outcome, 'APPROVED');
      } finally {
        Clubs.collection.upsert = originalUpsert;
        IngestionCandidates.update = originalCandidateUpdate;
      }

      const reopened = IngestionCandidates.findOne(firstId);
      const second = IngestionCandidates.findOne(secondId);
      const mappingAfterSecond = SourceEntityKeys.findOne({ keyType: 'group' });
      assert.isTrue(reobservedDuringProjection);
      assert.isTrue(reopenedBeforeCompletion);
      assert.equal(second.publicationState, 'COMPLETE');
      assert.equal(mappingAfterSecond.candidateFingerprint, second.fingerprint);
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint B Approved Under Lock',
      );
      assert.equal(reopened.reviewStatus, 'PENDING');
      assert.notProperty(reopened, 'publicationState');
      assert.notProperty(reopened, 'reviewedAt');
      assert.notProperty(reopened, 'reviewedBy');
      assert.notProperty(reopened, 'projectionVersion');
      assert.notProperty(reopened, 'projectionReferenceAt');
      assert.notProperty(reopened, 'canonicalTargets');
      assert.notProperty(reopened, 'approvalClaimToken');
      assert.notProperty(reopened, 'approvalClaimedAt');
      assert.notProperty(reopened, 'approvalClaimedBy');
      assert.notProperty(reopened, 'lastProjectionErrorCode');
      assert.equal(ReviewItems.findOne(`approval:${firstId}`).status, 'APPROVED');

      const correction = approveCandidate(firstId, admin, reobservedAt);
      const mappingAfterCorrection = SourceEntityKeys.findOne({ keyType: 'group' });
      assert.equal(correction.outcome, 'APPROVED');
      assert.equal(mappingAfterCorrection.candidateFingerprint, reopened.fingerprint);
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint A Reobserved',
      );
      assert.equal(
        errorFrom(() => approveCandidate(secondId, admin, new Date('2026-08-09T21:00:00.000Z'))),
        'ingestion-candidate-superseded',
      );
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Fingerprint A Reobserved',
      );
    });

    it('serializes different revisions and reclaims their stale source-item lock', function () {
      const olderId = addCandidate({ groupKey: 'locked-revision' });
      const newerId = addCandidate({
        groupKey: 'locked-revision',
        fields: { title: 'Latest Locked Revision' },
      });
      const newer = IngestionCandidates.findOne(newerId);
      const keyHash = crypto.createHash('sha256').update(newer.sourceItemKey).digest('hex');
      const lockId = `projection-lock:${newer.sourceId}:${keyHash}`;
      SourceEntityKeys.insert({
        _id: lockId,
        sourceId: newer.sourceId,
        keyType: 'projection_lock',
        keyHash,
        projectionCandidateId: olderId,
        projectionLockToken: 'active-older-revision',
        projectionLockUntil: new Date(Date.now() + (10 * 60 * 1000)),
        projectionLockUpdatedAt: new Date(),
      });

      const blocked = callAs(admin, INGESTION_REVIEW_METHODS.approveAll, [newerId]);
      assert.equal(blocked.blocked, 1);
      assert.equal(blocked.results[0].code, 'ingestion-source-item-projection-in-progress');
      assert.equal(IngestionCandidates.findOne(newerId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne(`approval:${newerId}`));
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);

      SourceEntityKeys.update(lockId, {
        $set: { projectionLockUntil: new Date(Date.now() - (10 * 60 * 1000)) },
      });
      const result = callAs(admin, INGESTION_REVIEW_METHODS.approve, newerId);
      const releasedLock = SourceEntityKeys.findOne(lockId);
      assert.equal(result.outcome, 'APPROVED');
      assert.equal(IngestionCandidates.findOne(newerId).publicationState, 'COMPLETE');
      assert.isUndefined(releasedLock.projectionLockToken);
      assert.isUndefined(releasedLock.projectionCandidateId);
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
    });

    it('approves groups before events and links every occurrence through the cutoff', function () {
      const eventId = addCandidate({ kind: 'event' });
      const groupId = addCandidate({ kind: 'group' });
      const result = callAs(admin, INGESTION_REVIEW_METHODS.approveAll, [eventId, groupId]);
      const club = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      const events = Events.collection.find({ importedFrom: 'MatchBook community intake' }).fetch();

      assert.equal(result.approved, 2);
      assert.equal(result.failed, 0);
      assert.lengthOf(events, 9);
      assert.equal(EventClubs.collection.find({ clubId: club._id }).count(), 9);
      assert.isTrue(events.every(event => event.eventID === club.clubID));
      assert.isTrue(events.every(event => event.createdBy === 'MatchBook community intake'));
      assert.isTrue(events.every(event => event.sourceId.includes('@202')));

      const replay = callAs(admin, INGESTION_REVIEW_METHODS.approve, eventId);
      assert.equal(replay.outcome, 'ALREADY_APPROVED');
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 9);
    });

    it('moves only source-managed links when an event revision changes parent', function () {
      const at = new Date('2026-08-09T22:30:00.000Z');
      const oldGroupId = addCandidate({
        groupKey: 'old-parent',
        fields: { title: 'Old Parent Group' },
      });
      const newGroupId = addCandidate({
        groupKey: 'new-parent',
        fields: {
          title: 'New Parent Group',
          locationLabels: ['Kapaʻa Civic Center'],
          recurrenceLabels: ['Tuesday at 5:00 pm'],
        },
      });
      approveCandidate(oldGroupId, admin, at);
      approveCandidate(newGroupId, admin, at);
      const oldClub = Clubs.collection.findOne({ name: 'Old Parent Group' });
      const newClub = Clubs.collection.findOne({ name: 'New Parent Group' });

      const firstRevisionId = addCandidate({
        kind: 'event',
        groupKey: 'old-parent',
        itemKey: 'event:moving-parent-slot',
      });
      approveCandidate(firstRevisionId, admin, at);
      const firstEvent = Events.collection.findOne({ importedFrom: 'MatchBook community intake' });
      const unrelatedClubId = makeClub({ name: 'Unrelated User-Managed Club' });
      EventClubs.collection.insert({
        eventId: firstEvent._id,
        clubId: unrelatedClubId,
        userId: member,
        createdAt: at,
      });

      const secondRevisionId = addCandidate({
        kind: 'event',
        groupKey: 'new-parent',
        itemKey: 'event:moving-parent-slot',
      });
      approveCandidate(secondRevisionId, admin, at);
      const importedEvents = Events.collection.find({
        importedFrom: 'MatchBook community intake',
      }).fetch();

      assert.lengthOf(importedEvents, 9);
      importedEvents.forEach(event => {
        const sourceLinks = EventClubs.collection.find({
          eventId: event._id,
          userId: 'MatchBook community intake',
        }).fetch();
        assert.lengthOf(sourceLinks, 1);
        assert.equal(sourceLinks[0].clubId, newClub._id);
        assert.equal(event.eventID, newClub.clubID);
      });
      assert.equal(EventClubs.collection.find({
        clubId: oldClub._id,
        userId: 'MatchBook community intake',
      }).count(), 0);
      assert.equal(EventClubs.collection.find({
        clubId: newClub._id,
        userId: 'MatchBook community intake',
      }).count(), 9);
      assert.equal(EventClubs.collection.find({
        eventId: firstEvent._id,
        clubId: unrelatedClubId,
        userId: member,
      }).count(), 1);
    });

    it('fails group reconciliation safely while its event revision lock is active', function () {
      const at = new Date('2026-08-09T22:30:00.000Z');
      const eventId = addCandidate({
        kind: 'event',
        groupKey: 'contended-parent',
        itemKey: 'event:contended-parent-slot',
      });
      approveCandidate(eventId, admin, at);
      assert.isTrue(Events.collection.find({}).fetch().every(event => event.eventID === 0));

      const eventCandidate = IngestionCandidates.findOne(eventId);
      const keyHash = crypto.createHash('sha256').update(eventCandidate.sourceItemKey).digest('hex');
      const eventLockId = `projection-lock:${eventCandidate.sourceId}:${keyHash}`;
      SourceEntityKeys.update(eventLockId, {
        $set: {
          projectionCandidateId: eventId,
          projectionLockToken: 'active-event-revision',
          projectionLockUntil: new Date(Date.now() + (10 * 60 * 1000)),
          projectionLockUpdatedAt: new Date(),
        },
      });
      const groupId = addCandidate({
        groupKey: 'contended-parent',
        fields: { title: 'Contended Parent Group' },
      });

      assert.equal(
        errorFrom(() => approveCandidate(groupId, admin, at)),
        'ingestion-source-item-projection-in-progress',
      );
      assert.equal(IngestionCandidates.findOne(groupId).publicationState, 'FAILED');
      assert.equal(EventClubs.collection.find({ userId: 'MatchBook community intake' }).count(), 0);
      assert.isTrue(Events.collection.find({}).fetch().every(event => event.eventID === 0));

      SourceEntityKeys.update(eventLockId, {
        $set: { projectionLockUntil: new Date(Date.now() - (10 * 60 * 1000)) },
      });
      const repaired = approveCandidate(groupId, admin, at);
      const club = Clubs.collection.findOne({ name: 'Contended Parent Group' });
      assert.equal(repaired.outcome, 'PUBLICATION_REPAIRED');
      assert.equal(EventClubs.collection.find({
        clubId: club._id,
        userId: 'MatchBook community intake',
      }).count(), 9);
      assert.isTrue(Events.collection.find({}).fetch().every(event => event.eventID === club.clubID));
    });

    it('reconciles an event approved before its group without publishing the group early', function () {
      const eventId = addCandidate({ kind: 'event' });
      const groupId = addCandidate({ kind: 'group' });

      callAs(admin, INGESTION_REVIEW_METHODS.approve, eventId);
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
      assert.isTrue(Events.collection.find({}).fetch().every(event => event.eventID === 0));

      callAs(admin, INGESTION_REVIEW_METHODS.approve, groupId);
      const club = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      assert.equal(EventClubs.collection.find({ clubId: club._id }).count(), 9);
      assert.isTrue(Events.collection.find({}).fetch().every(event => event.eventID === club.clubID));
    });

    it('blocks permission-only sources and sensitive access or contact data', function () {
      addSource({
        sourceId: 'SEN-005',
        policyStatus: 'PERMISSION_EVIDENCE_REQUIRED',
      });
      const permissionBlocked = addCandidate({ sourceId: 'SEN-005', groupKey: 'alz-test' });
      const privateContact = addCandidate({
        kind: 'event',
        groupKey: 'private-test',
        fields: { location: 'Call 808-555-0199 for the private meeting link' },
      });

      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_REVIEW_METHODS.approve, permissionBlocked)),
        'ingestion-permission-evidence-required',
      );
      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_REVIEW_METHODS.approve, privateContact)),
        'ingestion-sensitive-data-blocked',
      );
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
    });

    it('keeps PROBE_REQUIRED candidates private and reports a bounded batch breakdown', function () {
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      const probeId = addCandidate({ sourceId: 'SRC-001', groupKey: 'probe-group' });
      const approvedId = addCandidate({ groupKey: 'approved-group' });
      const result = callAs(admin, INGESTION_REVIEW_METHODS.approveAll, [probeId, approvedId, 'missing']);

      assert.equal(result.requested, 3);
      assert.equal(result.approved, 1);
      assert.equal(result.blocked, 1);
      assert.equal(result.skipped, 1);
      assert.equal(IngestionCandidates.findOne(probeId).reviewStatus, 'PENDING');
      assert.equal(IngestionCandidates.findOne(approvedId).reviewStatus, 'APPROVED');
    });

    it('uses a fail-closed local sandbox gate and publishes a generic event without raw description', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        groupKey: 'craft-fair',
        fields: {
          title: 'Kauaʻi Craft Fair',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T10:00:00',
          localEnd: '2026-08-20T12:00:00',
          location: 'Līhuʻe Civic Center',
          description: 'Vendors: email market@example.test or follow instagram.com/market.',
        },
      });
      const selection = { topicKey: 'food', subcategoryKey: 'local_market' };

      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, selection)),
        'ingestion-probe-only',
      );
      Meteor.settings.public.communityIngestionSandbox = true;
      const preview = previewCandidates(admin, [candidateId], at)[0];
      const result = approveCandidate(candidateId, admin, at, selection);
      const event = Events.collection.findOne({ importedFrom: 'MatchBook community intake' });

      assert.equal(preview.publicProjection.description, null);
      assert.equal(preview.publicProjection.sourceUrl, 'https://events.example.test/');
      assert.equal(result.outcome, 'APPROVED');
      assert.deepEqual(event.categories, ['food', 'local_market']);
      assert.deepEqual(event.topicIds, ['food']);
      assert.equal(event.publicationStatus, 'published');
      assert.equal(event.visibility, 'public');
      assert.notProperty(event, 'description');
      assert.notInclude(JSON.stringify(event), 'market@example.test');
      assert.notInclude(JSON.stringify(event), 'instagram.com');
    });

    it('waives SEN-005 permission only in sandbox while retaining sensitive payload validation', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({
        sourceId: 'SEN-005',
        policyStatus: 'PERMISSION_EVIDENCE_REQUIRED',
      });
      const permissionCandidate = addCandidate({
        sourceId: 'SEN-005',
        groupKey: 'caregiver-support',
      });
      assert.equal(
        errorFrom(() => approveCandidate(permissionCandidate, admin, at)),
        'ingestion-permission-evidence-required',
      );

      Meteor.settings.public.communityIngestionSandbox = true;
      assert.equal(approveCandidate(permissionCandidate, admin, at).outcome, 'APPROVED');
      const privateCandidate = addCandidate({
        kind: 'event',
        sourceId: 'SEN-005',
        groupKey: 'private-caregiver-support',
        fields: { location: 'Call 808-555-0199 for access' },
      });
      assert.equal(
        errorFrom(() => approveCandidate(privateCandidate, admin, at)),
        'ingestion-sensitive-data-blocked',
      );
      assert.equal(IngestionCandidates.findOne(privateCandidate).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne(`approval:${privateCandidate}`));
    });

    it('uses a rolling two-calendar-month Hawaii cutoff for every event occurrence', function () {
      const at = new Date('2026-01-31T22:00:00.000Z'); // January 31 at noon HST.
      assert.equal(
        ingestionPromotionCutoff(at).toISOString(),
        '2026-04-01T09:59:59.999Z',
      );
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const withinId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:cutoff-within',
        fields: {
          title: 'Cutoff Community Event',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-03-31T10:00:00',
          localEnd: '2026-03-31T11:00:00',
          location: 'Kapaʻa Library',
        },
      });
      const outsideId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:cutoff-outside',
        fields: {
          title: 'Later Community Event',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-04-01T00:00:00',
          localEnd: '2026-04-01T01:00:00',
          location: 'Kapaʻa Library',
        },
      });
      const selection = { topicKey: 'community', subcategoryKey: 'cultural_community' };

      assert.equal(approveCandidate(withinId, admin, at, selection).outcome, 'APPROVED');
      assert.equal(
        errorFrom(() => approveCandidate(outsideId, admin, at, selection)),
        'ingestion-event-outside-promotion-window',
      );
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(IngestionCandidates.findOne(outsideId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne(`approval:${outsideId}`));
    });

    it('previews duplicates without writes and permits an audited sandbox-only override', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const existingId = makeEvent({
        title: 'Farmers Market at Anaina Hou Community Park',
        date: new Date('2026-08-20T20:05:00.000Z'),
        location: 'Anaina Hou Community Park, 5-2723 Kuhio Highway, Kilauea, HI 96754',
        publicationStatus: 'published',
        owner: 'private-owner@example.test',
      });
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:fuzzy-duplicate',
        fields: {
          title: 'Anaina Hou Farmers Market',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T10:00:00',
          localEnd: '2026-08-20T12:00:00',
          location: 'Anaina Hou Community Park',
        },
      });
      const beforeCandidate = IngestionCandidates.findOne(candidateId);
      const beforeReviews = ReviewItems.find({}).count();
      const preview = previewCandidates(admin, [candidateId], at)[0];

      assert.equal(preview.duplicateLevel, 'BLOCK');
      assert.equal(preview.duplicates[0].id, existingId);
      assert.notProperty(preview.duplicates[0], 'owner');
      assert.deepEqual(IngestionCandidates.findOne(candidateId), beforeCandidate);
      assert.equal(ReviewItems.find({}).count(), beforeReviews);
      const selection = { topicKey: 'food', subcategoryKey: 'local_market' };
      let duplicateError;
      try {
        approveCandidate(candidateId, admin, at, selection);
      } catch (error) {
        duplicateError = error;
      }
      assert.equal(duplicateError.error, 'ingestion-duplicate-event');
      const safeDetails = JSON.parse(duplicateError.details);
      assert.sameMembers(Object.keys(safeDetails.matches[0]), [
        'id',
        'title',
        'date',
        'location',
        'titleSimilarity',
        'locationSimilarity',
        'minuteDelta',
        'level',
      ]);
      assert.isUndefined(ReviewItems.findOne(`approval:${candidateId}`));

      Meteor.settings.public.communityIngestionSandbox = false;
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, {
          ...selection,
          duplicateOverride: true,
        })),
        'ingestion-duplicate-override-not-allowed',
      );
      Meteor.settings.public.communityIngestionSandbox = true;
      const approved = approveCandidate(candidateId, admin, at, {
        ...selection,
        duplicateOverride: true,
      });
      assert.equal(approved.outcome, 'APPROVED');
      assert.isTrue(ReviewItems.findOne(`approval:${candidateId}`).duplicateOverrideUsed);
    });

    it('requires occurrence-level resolution for a recurring live duplicate variant', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      makeEvent({
        title: 'NAMI Peer Recovery Support Group',
        date: new Date('2026-09-01T23:30:00.000Z'),
        location: 'Līhuʻe Public Library',
        publicationStatus: 'published',
      });
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:nami-connection',
        fields: {
          title: 'Connection Recovery (Peer) Support Group',
          listingType: 'event',
          recurrenceLabel: 'Every Tuesday, 1:30 pm–3:00 pm',
          location: 'Lihue Library, 4344 Hardy Street, Lihue',
        },
      });
      const selection = { topicKey: 'community', subcategoryKey: 'cultural_community' };
      const preview = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(preview.duplicateLevel, 'REVIEW');
      assert.equal(preview.projectedOccurrenceCount, 9);
      assert.isFalse(preview.duplicateReviewAcknowledgmentAllowed);
      assert.isFalse(preview.bulkApprovalEligible);

      const batch = approveCandidateBatch(admin, [candidateId], selection, at);
      assert.equal(batch.blocked, 1);
      assert.equal(batch.results[0].code, 'ingestion-recurring-duplicate-review-required');
      assert.isUndefined(ReviewItems.findOne(`approval:${candidateId}`));
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, selection)),
        'ingestion-recurring-duplicate-review-required',
      );
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, {
          ...selection,
          duplicateReviewAcknowledged: true,
        })),
        'ingestion-recurring-duplicate-review-required',
      );
      assert.isUndefined(ReviewItems.findOne(`approval:${candidateId}`));
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
    });

    it('holds a live-variant duplicate support group for individual acknowledgment', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const existingId = makeClub({
        name: 'NAMI Kauaʻi Peer Recovery Group',
        location: 'Līhuʻe Public Library',
        meetingTime: 'Tuesdays at 1:30 pm',
        categories: ['support_group'],
        publicationStatus: 'published',
        owner: 'private-owner@example.test',
      });
      const candidateId = addCandidate({
        kind: 'group',
        groupKey: 'nami-connection-live-variant',
        fields: {
          title: 'Connection Recovery (Peer) Support Group',
          supportSubtype: 'mental_health_peer',
          recurrenceLabels: ['Every Tuesday, 1:30 pm–3:00 pm'],
          locationLabels: ['Lihue Library, 4344 Hardy Street, Lihue'],
        },
      });

      const preview = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(preview.duplicateLevel, 'REVIEW');
      assert.equal(preview.duplicates[0].id, existingId);
      assert.equal(preview.duplicates[0].meetingTime, 'Tuesdays at 1:30 pm');
      assert.notProperty(preview.duplicates[0], 'owner');
      assert.equal(preview.projectedOccurrenceCount, 1);
      assert.isTrue(preview.duplicateReviewAcknowledgmentAllowed);
      assert.isFalse(preview.bulkApprovalEligible);

      const batch = approveCandidateBatch(admin, [candidateId], {}, at);
      assert.equal(batch.blocked, 1);
      assert.equal(batch.results[0].code, 'ingestion-duplicate-review-required');
      assert.isUndefined(ReviewItems.findOne(`approval:${candidateId}`));
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at)),
        'ingestion-duplicate-review-required',
      );

      const approved = approveCandidate(candidateId, admin, at, {
        duplicateReviewAcknowledged: true,
      });
      assert.equal(approved.outcome, 'APPROVED');
      assert.isTrue(ReviewItems.findOne(`approval:${candidateId}`).duplicateReviewAcknowledged);
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
    });

    it('serializes fuzzy cross-source variants before either canonical write', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      addSource({ sourceId: 'SRC-002', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const firstFields = {
        title: 'Connection Recovery (Peer) Support Group',
        listingType: 'event',
        recurrenceLabel: null,
        localStart: '2026-08-21T18:00:00',
        localEnd: '2026-08-21T21:00:00',
        location: 'Lihue Library, 4344 Hardy Street, Lihue',
      };
      const secondFields = {
        ...firstFields,
        title: 'NAMI Peer Recovery Support Group',
        location: 'Līhuʻe Public Library',
      };
      const firstId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:cross-source-a',
        fields: firstFields,
      });
      const secondId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-002',
        itemKey: 'event:cross-source-b',
        fields: secondFields,
      });
      const selection = { topicKey: 'community', subcategoryKey: 'cultural_community' };
      const originalUpsert = Events.collection.upsert;
      let injected = false;
      let contentionCode;
      Events.collection.upsert = function (...args) {
        if (!injected) {
          injected = true;
          contentionCode = errorFrom(() => approveCandidate(secondId, admin, at, selection));
        }
        return originalUpsert.apply(this, args);
      };

      try {
        assert.equal(approveCandidate(firstId, admin, at, selection).outcome, 'APPROVED');
      } finally {
        Events.collection.upsert = originalUpsert;
      }

      assert.equal(contentionCode, 'ingestion-duplicate-slot-in-progress');
      assert.equal(IngestionCandidates.findOne(secondId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne(`approval:${secondId}`));
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(
        errorFrom(() => approveCandidate(secondId, admin, at, selection)),
        'ingestion-duplicate-review-required',
      );
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
    });

    it('serializes fuzzy group variants through the coarse group fence', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({
        sourceId: 'SEN-005',
        policyStatus: 'PERMISSION_EVIDENCE_REQUIRED',
      });
      Meteor.settings.public.communityIngestionSandbox = true;
      const firstId = addCandidate({
        kind: 'group',
        sourceId: 'SEN-001',
        itemKey: 'group:cross-source-a',
        fields: {
          title: 'Connection Recovery (Peer) Support Group',
          supportSubtype: 'mental_health_peer',
          recurrenceLabels: ['Every Tuesday, 1:30 pm–3:00 pm'],
          locationLabels: ['Lihue Library, 4344 Hardy Street, Lihue'],
        },
      });
      const secondId = addCandidate({
        kind: 'group',
        sourceId: 'SEN-005',
        itemKey: 'group:cross-source-b',
        fields: {
          title: 'NAMI Kauaʻi Peer Recovery Group',
          supportSubtype: 'mental_health_peer',
          recurrenceLabels: ['Tuesdays at 1:30 pm'],
          locationLabels: ['Līhuʻe Public Library'],
        },
      });
      const originalUpsert = Clubs.collection.upsert;
      let injected = false;
      let contentionCode;
      Clubs.collection.upsert = function (...args) {
        if (!injected) {
          injected = true;
          contentionCode = errorFrom(() => approveCandidate(secondId, admin, at));
        }
        return originalUpsert.apply(this, args);
      };

      try {
        assert.equal(approveCandidate(firstId, admin, at).outcome, 'APPROVED');
      } finally {
        Clubs.collection.upsert = originalUpsert;
      }

      assert.equal(contentionCode, 'ingestion-duplicate-slot-in-progress');
      assert.equal(IngestionCandidates.findOne(secondId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne(`approval:${secondId}`));
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(
        errorFrom(() => approveCandidate(secondId, admin, at)),
        'ingestion-duplicate-review-required',
      );
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
    });

    it('reports recurring canonical impact and rejects an oversized batch before approval', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const candidateIds = Array.from({ length: 112 }, (_, index) => addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: `event:batch-impact-${index}`,
        fields: {
          title: `Weekly Community Gathering ${index}`,
          listingType: 'event',
          recurrenceLabel: 'Monday at noon',
          location: `Community Room ${index}`,
        },
      }));
      const firstPreview = previewCandidates(admin, [candidateIds[0]], at)[0];
      assert.equal(firstPreview.projectedOccurrenceCount, 9);
      assert.equal(firstPreview.projectedFirstDate.toISOString(), '2026-08-10T22:00:00.000Z');
      assert.equal(firstPreview.projectedLastDate.toISOString(), '2026-10-05T22:00:00.000Z');

      let capError;
      try {
        approveCandidateBatch(
          admin,
          candidateIds,
          { topicKey: 'community', subcategoryKey: 'cultural_community' },
          at,
        );
      } catch (error) {
        capError = error;
      }
      assert.equal(capError.error, 'ingestion-batch-projection-too-large');
      assert.deepEqual(JSON.parse(capError.details), {
        projectedCanonicalRecords: 1008,
        limit: 1000,
      });
      assert.equal(ReviewItems.find({}).count(), 0);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
      assert.equal(IngestionCandidates.find({ reviewStatus: 'PENDING' }).count(), 112);
    });

    it('expands recurring series membership server-side and excludes dates after the cutoff', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const addSeriesDate = (itemKey, localStart) => addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey,
        observationFields: {},
        fields: {
          title: 'Weekly Lei Workshop',
          listingType: 'event',
          recurrenceLabel: null,
          localStart,
          localEnd: localStart.replace('10:00:00', '11:00:00'),
          location: 'Hanapēpē Art Center',
        },
      });
      const firstId = addSeriesDate('event:lei-aug-20', '2026-08-20T10:00:00');
      const secondId = addSeriesDate('event:lei-aug-27', '2026-08-27T10:00:00');
      const laterId = addSeriesDate('event:lei-nov-20', '2026-11-20T10:00:00');
      const selection = { topicKey: 'art', subcategoryKey: 'arts_crafts' };

      const result = approveCandidateSeries(admin, [secondId], selection, at);
      const action = ReviewItems.findOne(result.reviewActionId);
      assert.equal(result.requested, 1);
      assert.equal(result.seriesMembers, 3);
      assert.equal(result.eligible, 2);
      assert.equal(result.outsideHorizon, 1);
      assert.equal(result.approved, 2);
      assert.sameMembers(action.candidateIds, [firstId, secondId]);
      assert.deepEqual(action.excludedOutsideHorizonCandidateIds, [laterId]);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 2);
      assert.equal(IngestionCandidates.findOne(laterId).reviewStatus, 'PENDING');

      const replay = approveCandidateSeries(admin, [firstId], selection, at);
      assert.equal(replay.reviewActionId, result.reviewActionId);
      assert.equal(replay.alreadyApproved, 2);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 2);
    });

    it('keeps approve-all to protected or high-confidence source-category classifications', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const firstId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:legacy-market',
        fields: {
          title: 'Neighborhood Market',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T09:00:00',
          localEnd: '2026-08-20T10:00:00',
          location: 'Kōloa Town',
        },
      });
      const secondId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:legacy-talk',
        fields: {
          title: 'Community History Talk',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-21T18:00:00',
          localEnd: '2026-08-21T19:00:00',
          location: 'Kapaʻa Library',
        },
      });
      const blocked = approveCandidateBatch(admin, [firstId, secondId], {}, at);
      assert.equal(blocked.blocked, 2);
      assert.isFalse(previewCandidates(admin, [firstId], at)[0].bulkApprovalEligible);
      assert.equal(ReviewItems.find({ decision: 'APPROVE' }).count(), 0);

      const stillBlocked = callAs(
        admin,
        INGESTION_REVIEW_METHODS.approveAll,
        [firstId, secondId],
        { confirmAutomaticClassifications: true },
      );
      assert.equal(stillBlocked.approved, 0);
      assert.equal(stillBlocked.blocked, 2);
      const safeId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:source-category-market',
        fields: {
          title: 'Saturday Farmers Market',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-22T09:00:00',
          localEnd: '2026-08-22T10:00:00',
          location: 'Hanalei',
        },
        candidateFields: {
          classificationSuggestion: {
            taxonomyVersion: 'matchbook-topics.v1',
            topicKey: 'food',
            subcategoryKey: 'farmers_market',
            confidence: 0.96,
            reasons: ['SOURCE_CATEGORY_MATCH'],
          },
        },
      });
      const confirmed = callAs(
        admin,
        INGESTION_REVIEW_METHODS.approveAll,
        [safeId],
        { confirmAutomaticClassifications: true },
      );
      assert.equal(confirmed.approved, 1);
      assert.isTrue(previewCandidates(admin, [safeId], at)[0].bulkApprovalEligible);
      assert.isTrue(confirmed.automaticClassificationsConfirmed);
      assert.isTrue(ReviewItems.findOne(`approval:${safeId}`).automaticClassificationConfirmed);
      assert.isUndefined(ReviewItems.findOne(`approval:${firstId}`));
      assert.isUndefined(ReviewItems.findOne(`approval:${secondId}`));
    });

    it('previews and preflight-blocks missing locations and implausible event durations', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const missingLocationId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:no-location',
        fields: {
          title: 'Location Pending',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T10:00:00',
          localEnd: '2026-08-20T11:00:00',
          location: null,
        },
      });
      const longDurationId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:long-duration',
        fields: {
          title: 'Long Program',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T10:00:00',
          localEnd: '2026-08-24T16:00:00',
          location: 'Līhuʻe',
        },
      });
      const previews = previewCandidates(admin, [missingLocationId, longDurationId], at);
      assert.equal(previews[0].errorCode, 'ingestion-missing-required-field');
      assert.equal(previews[1].errorCode, 'ingestion-event-duration-review-required');

      const result = callAs(
        admin,
        INGESTION_REVIEW_METHODS.approveAll,
        [missingLocationId, longDurationId],
        { confirmAutomaticClassifications: true },
      );
      assert.equal(result.blocked, 2);
      assert.equal(IngestionCandidates.findOne(missingLocationId).reviewStatus, 'PENDING');
      assert.equal(IngestionCandidates.findOne(longDurationId).reviewStatus, 'PENDING');
      assert.equal(ReviewItems.find({ decision: 'APPROVE' }).count(), 0);
    });

    it('saves one audited editorial revision idempotently without mutating source provenance', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'editorial-audit' });
      const initialCandidate = IngestionCandidates.findOne(candidateId);
      const initialObservation = SourceObservations.findOne(initialCandidate.observationId);
      const initialPreview = previewCandidates(admin, [candidateId], at)[0];
      const patch = {
        title: 'Reviewed Recovery Circle',
        location: 'Kapaʻa Neighborhood Center',
        schedule: {
          kind: 'RECURRENCE',
          recurrenceLabel: 'Every Tuesday at 6:00 pm',
        },
      };

      assert.notProperty(initialPreview, 'editorialPreviewToken');
      assert.equal(
        errorFrom(() => callAs(
          member,
          INGESTION_REVIEW_METHODS.saveEditorialOverrides,
          candidateId,
          initialPreview.editorialEditToken,
          patch,
        )),
        'not-authorized',
      );
      const saved = callAs(
        admin,
        INGESTION_REVIEW_METHODS.saveEditorialOverrides,
        candidateId,
        initialPreview.editorialEditToken,
        patch,
      );
      const savedCandidate = IngestionCandidates.findOne(candidateId);
      const intent = ReviewItems.findOne({ candidateId, decision: 'EDIT_CANDIDATE_INTENT' });
      const applied = ReviewItems.findOne({ candidateId, decision: 'EDIT_CANDIDATE' });

      assert.equal(saved.editorialRevision, 1);
      assert.notEqual(saved.editorialEditToken, initialPreview.editorialEditToken);
      assert.notProperty(saved, 'editorialPreviewToken');
      assert.deepEqual(savedCandidate.normalizedFields, initialCandidate.normalizedFields);
      assert.equal(savedCandidate.fingerprint, initialCandidate.fingerprint);
      assert.deepEqual(
        SourceObservations.findOne(initialCandidate.observationId),
        initialObservation,
      );
      assert.equal(intent.status, 'RECORDED');
      assert.equal(intent.editorialRevisionBefore, 0);
      assert.equal(intent.editorialRevisionAfter, 1);
      assert.equal(applied.status, 'COMPLETE');
      assert.equal(applied.intentId, intent._id);
      assert.equal(applied.effectiveFieldsHash, intent.afterEffectiveFieldsHash);

      const retainedIntent = { ...intent };
      ReviewItems.remove(applied._id);
      const repaired = callAs(
        admin,
        INGESTION_REVIEW_METHODS.saveEditorialOverrides,
        candidateId,
        initialPreview.editorialEditToken,
        patch,
      );
      assert.equal(repaired.editorialRevision, 1);
      assert.equal(repaired.editorialEditToken, saved.editorialEditToken);
      assert.deepEqual(ReviewItems.findOne(intent._id), retainedIntent);
      assert.equal(ReviewItems.find({ candidateId, decision: 'EDIT_CANDIDATE' }).count(), 1);
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          candidateId,
          admin,
          initialPreview.editorialEditToken,
          { title: 'A stale edit' },
        )),
        'ingestion-editorial-edit-conflict',
      );

      const editedPreview = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(editedPreview.publicProjection.title, 'Reviewed Recovery Circle');
      assert.equal(editedPreview.publicProjection.location, 'Kapaʻa Neighborhood Center');
      assert.equal(editedPreview.publicProjection.meetingTime, 'Every Tuesday at 6:00 pm');
      assert.match(editedPreview.editorialPreviewToken, /^[a-f0-9]{64}$/);

      const cleared = callAs(
        admin,
        INGESTION_REVIEW_METHODS.saveEditorialOverrides,
        candidateId,
        saved.editorialEditToken,
        { title: null, location: null, schedule: null },
      );
      assert.equal(cleared.editorialRevision, 2);
      assert.deepEqual(cleared.editorialOverrides, {});
      const clearedPreview = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(clearedPreview.publicProjection.title, initialCandidate.normalizedFields.title);
      assert.equal(clearedPreview.publicProjection.location, 'Līhuʻe Civic Center');
      assert.equal(clearedPreview.publicProjection.meetingTime, 'Monday at noon');
    });

    it('recomputes validation and duplicate preview from the saved effective event fields', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:editorial-preview-fix',
        fields: {
          title: 'Unreviewed Community Talk',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: '2026-08-20T10:00:00',
          localEnd: '2026-08-24T16:00:00',
          location: null,
        },
      });
      const broken = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(broken.errorCode, 'ingestion-missing-required-field');

      callAs(
        admin,
        INGESTION_REVIEW_METHODS.saveEditorialOverrides,
        candidateId,
        broken.editorialEditToken,
        {
          title: 'Reviewed Community Talk',
          location: 'Līhuʻe Library',
          schedule: {
            kind: 'ONE_TIME',
            localStart: '2026-08-20T18:00:00',
            localEnd: '2026-08-20T19:00:00',
          },
        },
      );
      const duplicateId = makeEvent({
        title: 'Reviewed Community Talk',
        date: new Date('2026-08-21T04:00:00.000Z'),
        location: 'Līhuʻe Public Library',
        publicationStatus: 'published',
      });

      const fixed = previewCandidates(admin, [candidateId], at)[0];
      assert.notProperty(fixed, 'errorCode');
      assert.equal(fixed.projectedOccurrenceCount, 1);
      assert.equal(fixed.projectedFirstDate.toISOString(), '2026-08-21T04:00:00.000Z');
      assert.equal(fixed.publicProjection.title, 'Reviewed Community Talk');
      assert.equal(fixed.publicProjection.location, 'Līhuʻe Library');
      assert.equal(fixed.duplicateLevel, 'BLOCK');
      assert.lengthOf(fixed.duplicates, 1);
      assert.isFalse(fixed.bulkApprovalEligible);

      Events.collection.remove(duplicateId);
      const publishable = previewCandidates(admin, [candidateId], at)[0];
      const approved = approveCandidate(candidateId, admin, at, {
        topicKey: 'books',
        subcategoryKey: 'talks_discussions',
        editorialPreviewToken: publishable.editorialPreviewToken,
      });
      const projected = Events.collection.findOne({
        importedFrom: 'MatchBook community intake',
      });
      assert.equal(approved.outcome, 'APPROVED');
      assert.equal(projected.title, 'Reviewed Community Talk');
      assert.equal(projected.location, 'Līhuʻe Library');
      assert.equal(projected.date.toISOString(), '2026-08-21T04:00:00.000Z');
      assert.equal(projected.endDate.toISOString(), '2026-08-21T05:00:00.000Z');
    });

    it('publishes a worker-invalid event only after a bound editorial revalidation', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:invalid-schedule-corrected',
        fields: {
          title: 'Community Accounting Workshop',
          recurrenceLabel: null,
          localStart: null,
          localEnd: null,
          location: 'Kapaʻa Library',
        },
        candidateFields: { validationState: 'INVALID' },
      });
      IngestionCandidates.update(candidateId, {
        $unset: { 'normalizedFields.listingType': '' },
      });
      assert.notProperty(IngestionCandidates.findOne(candidateId).normalizedFields, 'listingType');
      const invalidPreview = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(invalidPreview.errorCode, 'ingestion-effective-validation-required');
      assert.equal(invalidPreview.sourceValidationState, 'INVALID');
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, {
          topicKey: 'books',
          subcategoryKey: 'classes_workshops',
        })),
        'ingestion-effective-validation-required',
      );
      assert.isUndefined(ReviewItems.findOne({ candidateId, decision: 'APPROVE' }));

      saveCandidateEditorialOverrides(
        candidateId,
        admin,
        invalidPreview.editorialEditToken,
        {
          schedule: {
            kind: 'ONE_TIME',
            localStart: '2026-08-24T17:30:00',
            localEnd: '2026-08-24T19:00:00',
          },
        },
        at,
      );
      const correctedPreview = previewCandidates(admin, [candidateId], at)[0];
      assert.notProperty(correctedPreview, 'errorCode');
      assert.equal(correctedPreview.sourceValidationState, 'INVALID');
      assert.equal(correctedPreview.effectiveValidationState, 'VALID');
      assert.equal(correctedPreview.effectiveValidationBasis, 'EDITORIAL_REVALIDATION');

      const result = approveCandidate(candidateId, admin, at, {
        topicKey: 'books',
        subcategoryKey: 'classes_workshops',
        editorialPreviewToken: correctedPreview.editorialPreviewToken,
      });
      const candidate = IngestionCandidates.findOne(candidateId);
      const decision = ReviewItems.findOne({ candidateId, decision: 'APPROVE' });
      const event = Events.collection.findOne({ importedFrom: 'MatchBook community intake' });
      assert.equal(result.outcome, 'APPROVED');
      assert.equal(candidate.validationState, 'INVALID');
      assert.equal(candidate.approvalSourceValidationState, 'INVALID');
      assert.equal(candidate.approvalEffectiveValidationState, 'VALID');
      assert.equal(candidate.approvalEffectiveValidationBasis, 'EDITORIAL_REVALIDATION');
      assert.equal(decision.sourceValidationState, 'INVALID');
      assert.equal(decision.effectiveValidationState, 'VALID');
      assert.equal(decision.effectiveValidationBasis, 'EDITORIAL_REVALIDATION');
      assert.equal(event.date.toISOString(), '2026-08-25T03:30:00.000Z');
      assert.equal(event.endDate.toISOString(), '2026-08-25T05:00:00.000Z');
    });

    it('keeps unsafe, unsupported, stale, and non-event invalid corrections closed', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      addSource({ sourceId: 'SRC-001', permission: 'PROBE_REQUIRED' });
      Meteor.settings.public.communityIngestionSandbox = true;
      const candidateId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'event:invalid-correction-guards',
        fields: {
          title: 'Schedule Needs Review',
          listingType: 'event',
          recurrenceLabel: null,
          localStart: null,
          localEnd: null,
          location: 'Līhuʻe Library',
        },
        candidateFields: { validationState: 'INVALID' },
      });
      const initial = previewCandidates(admin, [candidateId], at)[0];
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          candidateId,
          admin,
          initial.editorialEditToken,
          {
            schedule: {
              kind: 'RECURRENCE',
              recurrenceLabel: 'Whenever someone calls 808-555-1212',
            },
          },
          at,
        )),
        'ingestion-public-field-contact-blocked',
      );
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          candidateId,
          admin,
          initial.editorialEditToken,
          {
            schedule: {
              kind: 'RECURRENCE',
              recurrenceLabel: 'Occasional weekday evenings',
            },
          },
          at,
        )),
        'ingestion-unsupported-recurrence',
      );

      const firstSave = saveCandidateEditorialOverrides(
        candidateId,
        admin,
        initial.editorialEditToken,
        {
          schedule: {
            kind: 'ONE_TIME',
            localStart: '2026-08-26T18:00:00',
            localEnd: '2026-08-26T19:00:00',
          },
        },
        at,
      );
      const stalePreview = previewCandidates(admin, [candidateId], at)[0];
      saveCandidateEditorialOverrides(
        candidateId,
        admin,
        firstSave.editorialEditToken,
        { location: 'Kapaʻa Library' },
        at,
      );
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at, {
          topicKey: 'books',
          subcategoryKey: 'classes_workshops',
          editorialPreviewToken: stalePreview.editorialPreviewToken,
        })),
        'ingestion-editorial-preview-required',
      );
      assert.equal(IngestionCandidates.findOne(candidateId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne({ candidateId, decision: 'APPROVE' }));

      const printableId = addCandidate({
        kind: 'event',
        sourceId: 'SRC-001',
        itemKey: 'program:printable-program',
        fields: {
          title: 'Printable Recreation Program',
          listingType: 'printable_program',
          localStart: null,
          location: 'County Office',
        },
        candidateFields: {
          entityHint: 'printable_program',
          validationState: 'INVALID',
        },
      });
      const printable = previewCandidates(admin, [printableId], at)[0];
      assert.equal(printable.errorCode, 'ingestion-not-publishable');
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          printableId,
          admin,
          printable.editorialEditToken,
          {
            schedule: {
              kind: 'ONE_TIME',
              localStart: '2026-08-27T09:00:00',
            },
          },
          at,
        )),
        'ingestion-not-publishable',
      );
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
    });

    it('keeps an existing live revision unchanged while a newer correction is saved', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const firstId = addCandidate({
        groupKey: 'editorial-live-preservation',
        fields: { title: 'Currently Published Group' },
      });
      approveCandidate(firstId, admin, at);
      const liveBefore = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      const secondId = addCandidate({
        groupKey: 'editorial-live-preservation',
        fields: { title: 'New Source Revision' },
      });
      const preview = previewCandidates(admin, [secondId], at)[0];

      saveCandidateEditorialOverrides(
        secondId,
        admin,
        preview.editorialEditToken,
        { title: 'Corrected But Not Approved' },
        at,
      );

      const liveAfter = Clubs.collection.findOne(liveBefore._id);
      assert.equal(liveAfter.name, 'Currently Published Group');
      assert.equal(liveAfter.publicationStatus, 'published');
      assert.equal(IngestionCandidates.findOne(firstId).reviewStatus, 'APPROVED');
      assert.equal(IngestionCandidates.findOne(secondId).reviewStatus, 'PENDING');
      assert.isUndefined(ReviewItems.findOne({ candidateId: secondId, decision: 'APPROVE' }));
    });

    it('requires a fresh individual preview and publishes exactly the bound editorial revision', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'editorial-approval' });
      const initial = previewCandidates(admin, [candidateId], at)[0];
      const saved = saveCandidateEditorialOverrides(
        candidateId,
        admin,
        initial.editorialEditToken,
        {
          title: 'Editor Approved Group',
          location: 'Hanapēpē Neighborhood Center',
          schedule: {
            kind: 'RECURRENCE',
            recurrenceLabel: 'Every Wednesday at 5:30 pm',
          },
        },
        at,
      );

      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at)),
        'ingestion-editorial-preview-required',
      );
      const bulk = approveCandidateBatch(admin, [candidateId], {}, at);
      assert.equal(bulk.blocked, 1);
      assert.equal(
        bulk.results[0].code,
        'ingestion-editorial-individual-review-required',
      );
      assert.equal(
        errorFrom(() => approveCandidateSeries(admin, [candidateId], {}, at)),
        'ingestion-editorial-individual-review-required',
      );
      assert.isUndefined(ReviewItems.findOne({ candidateId, decision: 'APPROVE' }));

      const preview = previewCandidates(admin, [candidateId], at)[0];
      const approved = approveCandidate(candidateId, admin, at, {
        editorialPreviewToken: preview.editorialPreviewToken,
      });
      const club = Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' });
      const candidate = IngestionCandidates.findOne(candidateId);
      const decision = ReviewItems.findOne({ candidateId, decision: 'APPROVE' });

      assert.equal(approved.outcome, 'APPROVED');
      assert.equal(club.name, 'Editor Approved Group');
      assert.equal(club.location, 'Hanapēpē Neighborhood Center');
      assert.equal(club.meetingTime, 'Every Wednesday at 5:30 pm');
      assert.equal(candidate.editorialRevision, saved.editorialRevision);
      assert.equal(candidate.approvalEditorialRevision, saved.editorialRevision);
      assert.equal(candidate.approvalEffectiveFieldsHash, decision.effectiveFieldsHash);
      assert.equal(candidate.approvalDecisionId, decision._id);
      assert.equal(approveCandidate(candidateId, admin, at).outcome, 'ALREADY_APPROVED');
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          candidateId,
          admin,
          saved.editorialEditToken,
          { title: 'Too late to edit' },
          at,
        )),
        'ingestion-candidate-edit-not-pending',
      );
    });

    it('blocks unsafe editorial input and an older or already-claimed revision', function () {
      const firstId = addCandidate({ groupKey: 'editorial-state' });
      const initial = previewCandidates(admin, [firstId])[0];
      [
        { title: 'Email editor@example.test' },
        { location: 'See https://private.example.test' },
        {
          schedule: {
            kind: 'RECURRENCE',
            recurrenceLabel: 'Every Monday at noon; call 808-555-1212',
          },
        },
      ].forEach(patch => {
        assert.equal(
          errorFrom(() => saveCandidateEditorialOverrides(
            firstId,
            admin,
            initial.editorialEditToken,
            patch,
          )),
          'ingestion-public-field-contact-blocked',
        );
      });
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          firstId,
          admin,
          initial.editorialEditToken,
          {
            schedule: {
              kind: 'ONE_TIME',
              localStart: '2026-08-20T10:00:00',
            },
          },
        )),
        'ingestion-invalid-editorial-overrides',
      );

      IngestionCandidates.update(firstId, { $set: { reviewStatus: 'APPROVING' } });
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          firstId,
          admin,
          initial.editorialEditToken,
          { title: 'Claimed edit' },
        )),
        'ingestion-candidate-edit-not-pending',
      );
      IngestionCandidates.update(firstId, { $set: { reviewStatus: 'PENDING' } });
      addCandidate({
        groupKey: 'editorial-state',
        fields: { title: 'Newer source revision' },
        candidateFields: { lastObservedAt: new Date(Date.now() + 60 * 1000) },
      });
      assert.equal(
        errorFrom(() => saveCandidateEditorialOverrides(
          firstId,
          admin,
          initial.editorialEditToken,
          { title: 'Older edit' },
        )),
        'ingestion-candidate-superseded',
      );
    });

    it('rejects publication repair when effective fields no longer match the approved edit', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'editorial-binding-repair' });
      const initial = previewCandidates(admin, [candidateId], at)[0];
      saveCandidateEditorialOverrides(
        candidateId,
        admin,
        initial.editorialEditToken,
        { title: 'Bound Before Projection Failure' },
        at,
      );
      const preview = previewCandidates(admin, [candidateId], at)[0];
      const originalMappingUpsert = SourceEntityKeys.upsert;
      SourceEntityKeys.upsert = function (selector, ...args) {
        if (`${selector?._id || ''}`.startsWith('source-key:')) {
          throw new Meteor.Error('test-editorial-projection-failure', 'Stop after canonical write.');
        }
        return originalMappingUpsert.call(this, selector, ...args);
      };
      try {
        assert.equal(
          errorFrom(() => approveCandidate(candidateId, admin, at, {
            editorialPreviewToken: preview.editorialPreviewToken,
          })),
          'test-editorial-projection-failure',
        );
      } finally {
        SourceEntityKeys.upsert = originalMappingUpsert;
      }
      assert.equal(IngestionCandidates.findOne(candidateId).publicationState, 'FAILED');
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Bound Before Projection Failure',
      );

      IngestionCandidates.update(candidateId, {
        $set: { 'editorialOverrides.title': 'Unreviewed Database Tamper' },
      });
      assert.equal(
        errorFrom(() => approveCandidate(candidateId, admin, at)),
        'ingestion-editorial-binding-mismatch',
      );
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Bound Before Projection Failure',
      );
    });

    it('repairs a failed approval after same-fingerprint observation re-observation', function () {
      const at = new Date('2026-08-09T22:00:00.000Z');
      const candidateId = addCandidate({ groupKey: 'observation-churn-repair' });
      const initial = previewCandidates(admin, [candidateId], at)[0];
      saveCandidateEditorialOverrides(
        candidateId,
        admin,
        initial.editorialEditToken,
        { title: 'Reviewed Across Re-observation' },
        at,
      );
      const preview = previewCandidates(admin, [candidateId], at)[0];
      const before = IngestionCandidates.findOne(candidateId);
      const firstObservation = SourceObservations.findOne(before.observationId);
      const secondObservationId = `${before.observationId}-reobserved`;
      const originalMappingUpsert = SourceEntityKeys.upsert;
      let reobserved = false;

      SourceEntityKeys.upsert = function (selector, ...args) {
        if (!reobserved && `${selector?._id || ''}`.startsWith('source-key:')) {
          SourceObservations.insert({
            ...firstObservation,
            _id: secondObservationId,
            parserVersion: 'test.v2.same-fingerprint',
          });
          IngestionCandidates.update(candidateId, {
            $set: {
              observationId: secondObservationId,
              lastObservedAt: new Date('2026-08-09T22:05:00.000Z'),
            },
          });
          reobserved = true;
          throw new Meteor.Error(
            'test-reobserved-projection-failure',
            'Stop after canonical write and same-fingerprint re-observation.',
          );
        }
        return originalMappingUpsert.call(this, selector, ...args);
      };
      try {
        assert.equal(
          errorFrom(() => approveCandidate(candidateId, admin, at, {
            editorialPreviewToken: preview.editorialPreviewToken,
          })),
          'test-reobserved-projection-failure',
        );
      } finally {
        SourceEntityKeys.upsert = originalMappingUpsert;
      }

      const failed = IngestionCandidates.findOne(candidateId);
      const decision = ReviewItems.findOne({ candidateId, decision: 'APPROVE' });
      assert.isTrue(reobserved);
      assert.equal(failed.observationId, secondObservationId);
      assert.equal(failed.fingerprint, before.fingerprint);
      assert.equal(failed.publicationState, 'FAILED');
      assert.equal(failed.approvalEffectiveFieldsHash, decision.effectiveFieldsHash);
      assert.isDefined(SourceObservations.findOne(firstObservation._id));
      assert.isDefined(SourceObservations.findOne(secondObservationId));

      const repaired = approveCandidate(
        candidateId,
        admin,
        new Date('2026-08-10T00:00:00.000Z'),
      );
      assert.equal(repaired.outcome, 'PUBLICATION_REPAIRED');
      assert.equal(IngestionCandidates.findOne(candidateId).publicationState, 'COMPLETE');
      assert.equal(ReviewItems.findOne(decision._id).publicationState, 'COMPLETE');
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 1);
      assert.equal(
        Clubs.collection.findOne({ importedFrom: 'MatchBook community intake' }).name,
        'Reviewed Across Re-observation',
      );
    });

    it('refuses a non-support source even if its collection permission later changes', function () {
      addSource({ sourceId: 'SRC-001', permission: 'AUTOMATED_ALLOWED' });
      const candidateId = addCandidate({ sourceId: 'SRC-001', groupKey: 'ordinary-community-item' });

      assert.equal(
        errorFrom(() => callAs(admin, INGESTION_REVIEW_METHODS.approve, candidateId)),
        'ingestion-projection-not-implemented',
      );
      assert.equal(Clubs.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
      assert.equal(Events.collection.find({ importedFrom: 'MatchBook community intake' }).count(), 0);
    });
  });
}
