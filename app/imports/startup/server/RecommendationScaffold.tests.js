/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventSwipes } from '../../api/events/EventSwipes';
import { ProfileClubs } from '../../api/profile/ProfileClubs';
import { Profiles } from '../../api/profiles/Profiles';
import { FRIEND_ACTIVITY_VISIBILITY } from '../../api/privacy/FriendActivityPrivacy';
import {
  EventRSVPs,
  RecommendationEntities,
  RecommendationGraphEdges,
  RecommendationInteractions,
  RecommendationJobs,
  UserItemStates,
} from '../../api/recommendations/RecommendationData';
import { recordRecommendationInteraction } from '../../api/recommendations/interactionRecorder';
import {
  callAs,
  makeEvent,
  makeClub,
  makeUser,
  resetAll,
  resetRecommendations,
} from './testFixtures';
import {
  BACKFILL_KEYS,
  EVENT_PROJECTION_KEY,
  backfillGoingRsvps,
  backfillLegacyBehavior,
  ensureRecommendationScaffold,
  removeDoubleCountedMigrations,
} from './RecommendationScaffold';

if (Meteor.isServer) {
  describe('support recommendation projection', function () {
    // The first projection in a cold process writes to a dozen collections
    // that do not exist yet, while startup is still building their indexes.
    // Run on its own this suite is that first projection, and it crossed
    // Mocha's 2s default; in the full run something else had warmed it up.
    this.timeout(10000);

    beforeEach(function () {
      resetAll();
      resetRecommendations();
    });

    it('replaces the legacy wellness topic id and generated edge', function () {
      const now = new Date();
      const wellnessId = RecommendationEntities.collection.insert({
        entityType: 'topic',
        sourceId: 'topic:wellness',
        name: 'Plants & Home',
        createdAt: now,
        updatedAt: now,
      });
      const eventId = makeEvent({ categories: ['support_group'], topicIds: ['wellness'] });
      RecommendationGraphEdges.collection.insert({
        edgeKey: `event:${eventId}:has_topic:${wellnessId}`,
        fromType: 'event',
        fromId: eventId,
        toType: 'topic',
        toId: wellnessId,
        relation: 'has_topic',
        privacyEligibility: 'public',
        createdAt: now,
        updatedAt: now,
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['support']);
      const supportId = RecommendationEntities.collection.findOne({ sourceId: 'topic:support' })._id;
      const edges = RecommendationGraphEdges.collection.find({
        fromType: 'event', fromId: eventId, relation: 'has_topic',
      }).fetch();
      assert.deepEqual(edges.map(edge => edge.toId), [supportId]);
    });

    it('preserves an explicit multi-topic assignment', function () {
      const eventId = makeEvent({ categories: ['support_group'], topicIds: ['wellness', 'custom'] });
      ensureRecommendationScaffold();
      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['wellness', 'custom']);
    });

    it('moves the confirmed Lululemon yoga series out of the legacy outdoors topic', function () {
      const eventId = makeEvent({
        title: 'Lululemon Sunday Sweat',
        categories: ['fitness', 'wellness', 'free'],
        topicIds: ['outdoors'],
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['wellness']);
      const wellnessId = RecommendationEntities.collection.findOne({ sourceId: 'topic:wellness' })._id;
      const edges = RecommendationGraphEdges.collection.find({
        fromType: 'event', fromId: eventId, relation: 'has_topic',
      }).fetch();
      assert.deepEqual(edges.map(edge => edge.toId), [wellnessId]);
    });

    it('preserves a future editorial topic for the confirmed Lululemon series', function () {
      const eventId = makeEvent({
        title: 'Lululemon Sunday Sweat',
        categories: ['fitness', 'wellness', 'free'],
        topicIds: ['community'],
      });

      ensureRecommendationScaffold();

      assert.deepEqual(Events.collection.findOne(eventId).topicIds, ['community']);
    });

    /**
     * The rules are friendActivitySync's and are tested there. What is pinned
     * here is that the scaffold runs them at boot: a row stored as shareable
     * is corrected when its listing is sensitive, and a row is shareable only
     * for a person who has turned sharing on.
     */
    it('settles friend-activity visibility from the listing and the person’s choice', function () {
      const supportClubId = makeClub({ categories: ['support_group'] });
      const ordinaryClubId = makeClub({ categories: ['community'] });
      const supportEventId = makeEvent({ categories: ['support_group'] });
      Profiles.collection.insert({
        userId: 'privacy-test',
        email: 'privacy-test@test.example',
        friendActivitySharing: true,
      });
      ProfileClubs.collection.insert({
        userId: 'never-asked',
        clubId: ordinaryClubId,
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
      });
      ProfileClubs.collection.insert({
        userId: 'privacy-test',
        clubId: supportClubId,
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
      });
      ProfileClubs.collection.insert({
        userId: 'privacy-test',
        clubId: ordinaryClubId,
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.private,
      });
      EventSwipes.collection.insert({
        userId: 'privacy-test',
        eventId: supportEventId,
        decision: 'going',
        friendActivityVisibility: FRIEND_ACTIVITY_VISIBILITY.shareable,
      });

      ensureRecommendationScaffold();

      assert.equal(
        ProfileClubs.collection.findOne({ clubId: supportClubId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.private,
      );
      assert.equal(
        ProfileClubs.collection.findOne({ userId: 'privacy-test', clubId: ordinaryClubId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.shareable,
      );
      assert.equal(
        ProfileClubs.collection.findOne({ userId: 'never-asked', clubId: ordinaryClubId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.private,
      );
      assert.equal(
        EventSwipes.collection.findOne({ eventId: supportEventId }).friendActivityVisibility,
        FRIEND_ACTIVITY_VISIBILITY.private,
      );
      assert.deepEqual(Clubs.collection.findOne(supportClubId).categories, ['support_group']);
    });
  });

  /**
   * Every boot used to re-project every event: 4.3 s on a copy of the
   * development database, before the server would take a connection. The
   * first walk is complete; later ones cover what can have changed.
   */
  describe('event projection walk', function () {
    this.timeout(10000);

    const lastWalk = () => RecommendationJobs.collection.findOne({ idempotencyKey: EVENT_PROJECTION_KEY });
    const organizerEdges = eventId => RecommendationGraphEdges.collection
      .find({ fromType: 'organizer', toId: eventId, relation: 'hosts' }).count();

    beforeEach(function () {
      resetAll();
      resetRecommendations();
    });

    it('walks every event once, then only the new, the edited and the unfinished', function () {
      const settledId = makeEvent({ categories: ['music'], hostName: 'First host' });
      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 1, complete: true });
      assert.equal(lastWalk().jobType, 'project_graph');

      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 0, complete: false });

      const newId = makeEvent({ categories: ['music'], createdAt: new Date() });
      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 1, complete: false });
      assert.deepEqual(Events.collection.findOne(newId).topicIds, ['music']);

      Events.collection.update(settledId, { $set: { hostName: 'Second host', updatedAt: new Date() } });
      Events.collection.update(newId, { $unset: { venueId: '' } });
      ensureRecommendationScaffold();
      assert.equal(lastWalk().counts.events, 2);
      assert.equal(organizerEdges(settledId), 2, 'the edit reached the graph');
      assert.isOk(Events.collection.findOne(newId).venueId);
    });

    // A host link is a row in EventClubs, and 'Clubs.organizeEvent' writes one
    // without touching the event. A walk that read only the event's own
    // timestamps never saw it, and the graph went without the edge.
    it('picks up an event that has gained a host, though the event itself did not change', function () {
      const eventId = makeEvent({ categories: ['music'] });
      const clubId = makeClub();
      const hostEdges = () => RecommendationGraphEdges.collection
        .find({ edgeKey: `group:${clubId}:hosts:${eventId}` }).count();
      ensureRecommendationScaffold();
      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 0, complete: false });
      assert.equal(hostEdges(), 0);

      // An administrator, because the method is no longer open to a passer-by.
      callAs(makeUser({ admin: true }), 'Clubs.organizeEvent', { clubID: clubId, eventID: eventId });

      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 1, complete: false });
      assert.equal(hostEdges(), 1);
    });

    it('walks everything again when the topic or venue tables it was built from have changed', function () {
      makeEvent({ categories: ['music'] });
      makeEvent({ categories: ['books'] });
      ensureRecommendationScaffold();
      RecommendationJobs.collection.update(
        { idempotencyKey: EVENT_PROJECTION_KEY },
        { $set: { 'configuration.fingerprint': 'built from older tables' } },
      );

      ensureRecommendationScaffold();
      assert.deepEqual(lastWalk().counts, { events: 2, complete: true });
    });
  });

  /**
   * The scaffold used to replay every swipe and membership on every boot, so
   * the first restart after any live swipe recorded it a second time. Each
   * test here is one way that could come back.
   */
  describe('behaviour backfill', function () {
    this.timeout(10000);

    let userId;
    let recommendationSettings;

    const interactionsFor = entityId => RecommendationInteractions.collection.find({ userId, entityId }).fetch();
    const actionsFor = entityId => interactionsFor(entityId).map(interaction => interaction.action);
    const signalCount = (entityId, action) => UserItemStates.collection
      .findOne({ userId, entityId })?.signalCounts?.[action];
    const edgesFor = entityId => RecommendationGraphEdges.collection.find({ fromId: userId, toId: entityId }).count();

    // A row from before the recommendation log existed: in the collection,
    // with nothing recorded about it. Validation is bypassed because one of
    // the rows this must cope with is a stray 'interested', which the schema
    // rightly no longer accepts from anything live.
    const storedSwipe = (eventId, decision, kind = 'event', createdAt = new Date('2026-05-01T10:00:00Z')) => (
      EventSwipes.collection.insert({ userId, eventId, decision, kind, createdAt }, { bypassCollection2: true })
    );

    // The interaction the OLD scaffold wrote for a swipe, as it wrote it.
    const replayedInteraction = (swipeId, fields) => RecommendationInteractions.collection.insert({
      userId,
      clientEventId: `migration:EventSwipes:${swipeId}`,
      source: 'migration',
      createdAt: new Date(),
      ...fields,
    });

    beforeEach(function () {
      resetAll();
      resetRecommendations();
      recommendationSettings = Meteor.settings.recommendations;
      userId = makeUser();
    });

    afterEach(function () {
      Meteor.settings.recommendations = recommendationSettings;
    });

    it('does not record a live swipe or a live join a second time at the next boot', function () {
      const goingId = makeEvent();
      const passedId = makeEvent();
      const clubId = makeClub();
      callAs(userId, 'eventSwipes.record', goingId, 'going');
      callAs(userId, 'eventSwipes.record', passedId, 'passed');
      callAs(userId, 'profileClubs.add', clubId);
      callAs(userId, 'eventSwipes.record', clubId, 'joined', 'club');

      ensureRecommendationScaffold();
      ensureRecommendationScaffold();

      assert.deepEqual(actionsFor(goingId), ['rsvp_going']);
      assert.deepEqual(actionsFor(passedId), ['passed']);
      assert.deepEqual(actionsFor(clubId), ['joined_group'], 'a join is one signal, not a join and a swipe');
      assert.equal(signalCount(goingId, 'rsvp_going'), 1);
      assert.equal(signalCount(clubId, 'joined_group'), 1);
      assert.equal(edgesFor(goingId), 1);
      assert.equal(edgesFor(clubId), 1);
    });

    it('records what was there before the log existed, under the names in use now', function () {
      const goingId = makeEvent();
      const strayId = makeEvent();
      const passedId = makeEvent();
      const swipedClubId = makeClub();
      const memberClubId = makeClub();
      storedSwipe(goingId, 'going');
      storedSwipe(strayId, 'interested');
      storedSwipe(passedId, 'passed');
      storedSwipe(swipedClubId, 'joined', 'club');
      ProfileClubs.collection.insert({ userId, clubId: memberClubId });

      ensureRecommendationScaffold();

      assert.deepEqual(actionsFor(goingId), ['rsvp_going']);
      assert.deepEqual(actionsFor(strayId), ['rsvp_going'], 'a stray "interested" is a Going under its old name');
      assert.deepEqual(actionsFor(passedId), ['passed']);
      assert.deepEqual(actionsFor(swipedClubId), [], 'the membership row is what says joined_group');
      assert.deepEqual(actionsFor(memberClubId), ['joined_group']);
      assert.equal(interactionsFor(goingId)[0].source, 'migration');
      assert.equal(interactionsFor(goingId)[0].occurredAt.toISOString(), '2026-05-01T10:00:00.000Z');
      assert.isUndefined(interactionsFor(memberClubId)[0].occurredAt, 'an unknown time stays unknown');
    });

    it('walks the collections once per database, and says so in RecommendationJobs', function () {
      storedSwipe(makeEvent(), 'passed');
      ensureRecommendationScaffold();

      const job = RecommendationJobs.collection.findOne({ idempotencyKey: BACKFILL_KEYS.legacyBehavior });
      assert.equal(job.jobType, 'backfill');
      assert.equal(job.status, 'succeeded');
      assert.deepEqual(job.counts, { memberships: 0, swipes: 1, alreadyRecorded: 0, alreadyReplayed: 0 });

      // A row that only a second walk could find. Nothing live writes a swipe
      // without recording it, so there is nothing for a second walk to do.
      const laterId = makeEvent();
      storedSwipe(laterId, 'passed');
      ensureRecommendationScaffold();

      assert.deepEqual(actionsFor(laterId), []);
      assert.equal(RecommendationJobs.collection.find({ jobType: 'backfill' }).count(), 3);
    });

    it('gives every Going swipe its RSVP, including the ones first logged as "interested"', function () {
      const loggedId = makeEvent();
      const unloggedId = makeEvent();
      const clubId = makeClub();
      const loggedSwipeId = storedSwipe(loggedId, 'going');
      storedSwipe(unloggedId, 'going');
      storedSwipe(clubId, 'joined', 'club');
      RecommendationInteractions.collection.insert({
        userId,
        entityType: 'event',
        entityId: loggedId,
        action: 'interested',
        occurredAt: new Date('2026-05-01T10:00:00Z'),
        clientEventId: 'swipe:live-before-the-rename',
        source: 'legacy',
        createdAt: new Date(),
      });

      ensureRecommendationScaffold();

      assert.equal(EventRSVPs.collection.findOne({ userId, eventId: loggedId }).status, 'going');
      assert.equal(EventRSVPs.collection.findOne({ userId, eventId: unloggedId }).status, 'going');
      assert.equal(EventRSVPs.collection.find({ userId }).count(), 2, 'a joined group is not an RSVP');
      assert.sameMembers(actionsFor(loggedId), ['interested', 'rsvp_going']);
      assert.isOk(RecommendationInteractions.collection.findOne({ clientEventId: `migration:going:${loggedSwipeId}` }));
      assert.deepEqual(actionsFor(unloggedId), ['rsvp_going'], 'the behaviour backfill had already made this one');

      assert.deepEqual(backfillGoingRsvps(), { rsvps: 0 }, 'only where none exists');
    });

    describe('cleaning up the double count already written', function () {
      const LIVE_AT = new Date('2026-06-01T09:00:00.000Z');
      const REPLAYED_AT = new Date('2026-06-01T09:00:00.004Z');

      // Both halves of one doubled gesture, written through the recorder so
      // each has its edge and its count — which is what the old boot produced.
      const doubled = (entityType, entityId, action, replayKey) => {
        recordRecommendationInteraction({
          userId, entityType, entityId, action, occurredAt: LIVE_AT, clientEventId: `live:${entityId}`, source: 'legacy',
        });
        return recordRecommendationInteraction({
          userId,
          entityType,
          entityId,
          action,
          occurredAt: REPLAYED_AT,
          clientEventId: replayKey,
          source: 'migration',
        });
      };

      it('removes the replayed twin with its edge and its count, and only that', function () {
        const passedId = makeEvent();
        const clubId = makeClub();
        const replayedPass = doubled('event', passedId, 'passed', 'migration:EventSwipes:swipe-1');
        doubled('group', clubId, 'joined_group', 'migration:ProfileClubs:membership-1');
        assert.equal(signalCount(passedId, 'passed'), 2);
        assert.equal(edgesFor(clubId), 2);

        assert.deepEqual(removeDoubleCountedMigrations(), { removed: 2 });

        assert.equal(signalCount(passedId, 'passed'), 1);
        assert.equal(signalCount(clubId, 'joined_group'), 1);
        assert.equal(edgesFor(passedId), 1);
        assert.equal(edgesFor(clubId), 1);
        assert.deepEqual(interactionsFor(passedId).map(interaction => interaction.source), ['legacy']);
        assert.isUndefined(RecommendationGraphEdges.collection.findOne({ edgeKey: `interaction:${replayedPass}` }));

        assert.deepEqual(removeDoubleCountedMigrations(), { removed: 0 });
        assert.equal(signalCount(passedId, 'passed'), 1, 'running it again takes nothing more away');
      });

      it('reaches the doubles stored under the retired name', function () {
        const eventId = makeEvent();
        const fields = { entityType: 'event', entityId: eventId, action: 'interested' };
        RecommendationInteractions.collection.insert({
          userId, ...fields, occurredAt: LIVE_AT, clientEventId: 'live:interested', source: 'legacy', createdAt: LIVE_AT,
        });
        replayedInteraction('swipe-2', { ...fields, occurredAt: REPLAYED_AT });

        assert.deepEqual(removeDoubleCountedMigrations(), { removed: 1 });
        assert.deepEqual(interactionsFor(eventId).map(interaction => interaction.source), ['legacy']);
      });

      /**
       * It deletes, so where it cannot show that two rows are one gesture it
       * leaves both. A pass from before the log existed and a pass made last
       * week are two gestures.
       */
      it('keeps replayed history that is not a duplicate', function () {
        const earlierId = makeEvent();
        const undatedId = makeEvent();
        const unmatchedId = makeEvent();
        replayedInteraction('swipe-3', {
          entityType: 'event', entityId: earlierId, action: 'passed', occurredAt: new Date('2025-11-01T09:00:00Z'),
        });
        recordRecommendationInteraction({
          userId, entityType: 'event', entityId: earlierId, action: 'passed', occurredAt: LIVE_AT, source: 'legacy',
        });
        replayedInteraction('swipe-4', { entityType: 'event', entityId: undatedId, action: 'passed' });
        recordRecommendationInteraction({
          userId, entityType: 'event', entityId: undatedId, action: 'passed', occurredAt: LIVE_AT, source: 'legacy',
        });
        replayedInteraction('swipe-5', {
          entityType: 'event', entityId: unmatchedId, action: 'passed', occurredAt: REPLAYED_AT,
        });

        assert.deepEqual(removeDoubleCountedMigrations(), { removed: 0 });
        assert.lengthOf(interactionsFor(earlierId), 2);
        assert.lengthOf(interactionsFor(undatedId), 2);
        assert.lengthOf(interactionsFor(unmatchedId), 1);
      });

      it('runs at boot, once, before the backfill looks at the log', function () {
        const passedId = makeEvent();
        const swipeId = storedSwipe(passedId, 'passed');
        doubled('event', passedId, 'passed', `migration:EventSwipes:${swipeId}`);

        ensureRecommendationScaffold();

        assert.deepEqual(interactionsFor(passedId).map(interaction => interaction.source), ['legacy']);
        assert.equal(signalCount(passedId, 'passed'), 1);
        const job = RecommendationJobs.collection.findOne({ idempotencyKey: BACKFILL_KEYS.doubleCountCleanup });
        assert.deepEqual(job.counts, { removed: 1 });
      });
    });

    it('waits for recording to be on before backfilling behaviour, but not before keeping RSVPs', function () {
      const goingId = makeEvent();
      storedSwipe(goingId, 'going');
      Meteor.settings.recommendations = { ...recommendationSettings, recordInteractions: false };

      ensureRecommendationScaffold();

      assert.equal(EventRSVPs.collection.findOne({ userId, eventId: goingId }).status, 'going');
      assert.deepEqual(actionsFor(goingId), []);
      assert.isUndefined(RecommendationJobs.collection.findOne({ idempotencyKey: BACKFILL_KEYS.legacyBehavior }));

      Meteor.settings.recommendations = recommendationSettings;
      ensureRecommendationScaffold();

      assert.deepEqual(actionsFor(goingId), ['rsvp_going']);
      assert.isOk(RecommendationJobs.collection.findOne({ idempotencyKey: BACKFILL_KEYS.legacyBehavior }));
    });

    it('counts what it wrote, not what it looked at', function () {
      const liveId = makeEvent();
      const replayedId = makeEvent();
      callAs(userId, 'eventSwipes.record', liveId, 'passed');
      const replayedSwipeId = storedSwipe(replayedId, 'going');
      replayedInteraction(replayedSwipeId, { entityType: 'event', entityId: replayedId, action: 'interested' });
      storedSwipe(makeEvent(), 'passed');

      assert.deepEqual(
        backfillLegacyBehavior(),
        { memberships: 0, swipes: 1, alreadyRecorded: 1, alreadyReplayed: 1 },
      );
      assert.deepEqual(actionsFor(liveId), ['passed']);
      assert.deepEqual(actionsFor(replayedId), ['interested'], 'its RSVP comes from backfillGoingRsvps');
    });
  });
}
