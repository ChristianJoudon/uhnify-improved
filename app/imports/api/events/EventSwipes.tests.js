/* eslint-env mocha */
import { assert } from 'chai';
import { Meteor } from 'meteor/meteor';
import { EventSwipes } from './EventSwipes';
import { ProfileClubs } from '../profile/ProfileClubs';
import { RecommendationInteractions } from '../recommendations/RecommendationData';
import {
  callAs,
  errorFrom,
  makeClub,
  makeEvent,
  makeUser,
  resetAll,
  resetRecommendations,
} from '../../startup/server/testFixtures';

/**
 * A right swipe, under its real names.
 *
 * It used to be stored as 'interested' whatever it was on, and every reader
 * made up its own meaning: one page listed it as Saved, a button called it
 * Going, and the recommender scored a join as mild curiosity on top of the
 * 'joined_group' it had already been given. The owner's decision is that a
 * right swipe on an event is an RSVP — "Going" — and on a group it is joining.
 *
 * So these tests are about two things that are easy to get quietly wrong: that
 * a decision can only be stored against the kind of listing it makes sense
 * for, and that the recommender is told exactly one true thing per gesture.
 * The second is asserted on the interaction rows themselves, because a double
 * count does not fail anything — it just makes every later ranking a little
 * worse, for ever.
 */
if (Meteor.isServer) {
  describe('event swipes', function () {
    this.timeout(10000);

    let person;

    /** Sorted, because rows written in the same millisecond have no order worth
        asserting on; what matters is which actions were recorded and how often. */
    const actionsOn = entityId => RecommendationInteractions.collection
      .find({ userId: person, entityId })
      .map(row => row.action)
      .sort();

    const interactionOn = (entityId, action) => RecommendationInteractions.collection
      .findOne({ userId: person, entityId, action });

    const swipeOn = eventId => EventSwipes.collection.findOne({ userId: person, eventId });

    beforeEach(function () {
      resetAll();
      resetRecommendations();
      person = makeUser();
    });

    describe('which decision fits which kind', function () {
      it('stores going against an event and joined against a group', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        callAs(person, 'eventSwipes.record', eventId, 'going');
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        assert.include(swipeOn(eventId), { decision: 'going', kind: 'event' });
        assert.include(swipeOn(clubId), { decision: 'joined', kind: 'club' });
      });

      it('refuses going on a group', function () {
        const clubId = makeClub();
        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', clubId, 'going', 'club')),
          'decision-kind-mismatch',
        );
        assert.isUndefined(swipeOn(clubId), 'nothing is stored for a pair that does not fit');
      });

      it('refuses joined on an event, named or by default', function () {
        const eventId = makeEvent();
        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', eventId, 'joined', 'event')),
          'decision-kind-mismatch',
        );
        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', eventId, 'joined')),
          'decision-kind-mismatch',
        );
        assert.isUndefined(swipeOn(eventId));
      });

      it('lets a pass be on either', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        callAs(person, 'eventSwipes.record', eventId, 'passed');
        callAs(person, 'eventSwipes.record', clubId, 'passed', 'club');

        assert.include(swipeOn(eventId), { decision: 'passed', kind: 'event' });
        assert.include(swipeOn(clubId), { decision: 'passed', kind: 'club' });
      });

      it('no longer knows the old word', function () {
        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', makeEvent(), 'interested')),
          'invalid-decision',
        );
      });

      it('tells a person, not a programmer, why a pair was refused', function () {
        try {
          callAs(person, 'eventSwipes.record', makeClub(), 'going', 'club');
          assert.fail('going on a group should have been refused');
        } catch (error) {
          assert.equal(error.reason, 'Going is for events. To be part of a group, join it.');
        }
      });

      /**
       * The deck sends the join and then the swipe, as two calls, and the join
       * can fail by itself — it shares a rate limit with every other method.
       * The swipe used to land anyway: the card was hidden for good and the row
       * said 'joined' about somebody who was not a member.
       */
      it('refuses joined where there is no membership behind it', function () {
        const clubId = makeClub();

        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', clubId, 'joined', 'club')),
          'not-a-member',
        );
        assert.isUndefined(swipeOn(clubId), 'a join that did not land leaves no swipe saying it did');
        assert.deepEqual(actionsOn(clubId), []);
      });

      it('goes by the caller’s own membership, not somebody else’s', function () {
        const clubId = makeClub();
        callAs(makeUser(), 'profileClubs.add', clubId);

        assert.equal(
          errorFrom(() => callAs(person, 'eventSwipes.record', clubId, 'joined', 'club')),
          'not-a-member',
        );
      });

      it('asks for no membership before a pass on a group', function () {
        const clubId = makeClub();
        assert.isNull(errorFrom(() => callAs(person, 'eventSwipes.record', clubId, 'passed', 'club')));
      });
    });

    describe('what the recommender is told when a swipe is recorded', function () {
      it('hears going as an RSVP, once', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'going');

        assert.deepEqual(actionsOn(eventId), ['rsvp_going']);
        assert.equal(interactionOn(eventId, 'rsvp_going').entityType, 'event');
      });

      it('hears a pass as a pass, on an event or a group', function () {
        const eventId = makeEvent();
        const clubId = makeClub();
        callAs(person, 'eventSwipes.record', eventId, 'passed');
        callAs(person, 'eventSwipes.record', clubId, 'passed', 'club');

        assert.deepEqual(actionsOn(eventId), ['passed']);
        assert.deepEqual(actionsOn(clubId), ['passed']);
        assert.equal(interactionOn(clubId, 'passed').entityType, 'group');
      });

      /**
       * The deck's right swipe on a group makes two calls — the join, then the
       * swipe — and each used to report to the recommender. One gesture is one
       * signal, and the join is the one that says what happened.
       */
      it('hears a right swipe on a group as the join and nothing else', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        assert.deepEqual(actionsOn(clubId), ['joined_group']);
        assert.equal(
          RecommendationInteractions.collection
            .find({ userId: person, action: { $in: ['interested', 'rsvp_going'] } }).count(),
          0,
          'a join is neither curiosity nor an RSVP',
        );
      });

      it('hears nothing at all from the joined swipe itself', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        const heardSoFar = RecommendationInteractions.collection.find({ userId: person }).count();

        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        assert.equal(RecommendationInteractions.collection.find({ userId: person }).count(), heardSoFar);
      });

      it('hears the new decision when a pass becomes going', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'passed');
        callAs(person, 'eventSwipes.record', eventId, 'going');

        assert.equal(swipeOn(eventId).decision, 'going');
        assert.deepEqual(actionsOn(eventId), ['passed', 'rsvp_going']);
      });

      it('hears the RSVP cancelled, and then the pass, when going becomes a pass', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'going');
        callAs(person, 'eventSwipes.record', eventId, 'passed');

        assert.equal(swipeOn(eventId).decision, 'passed');
        assert.deepEqual(actionsOn(eventId), ['passed', 'rsvp_canceled', 'rsvp_going']);
        assert.deepEqual(interactionOn(eventId, 'rsvp_canceled').context, { reason: 'passed' });
      });

      /**
       * The recorder drops a second row under the same clientEventId, which is
       * how it survives a retried call. Going-to-passed writes two rows from
       * one call, so without an id of its own the cancellation would swallow
       * the pass, or the other way round.
       */
      it('keeps both halves of going-to-passed when the deck supplies a client event id', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'going', 'event', { clientEventId: 'swipe:first' });
        callAs(person, 'eventSwipes.record', eventId, 'passed', 'event', { clientEventId: 'swipe:second' });

        assert.deepEqual(actionsOn(eventId), ['passed', 'rsvp_canceled', 'rsvp_going']);
        assert.equal(interactionOn(eventId, 'passed').clientEventId, 'swipe:second');
        assert.equal(interactionOn(eventId, 'rsvp_canceled').clientEventId, 'swipe:second:rsvp_canceled');
      });

      it('does not count saying the same thing twice as two decisions', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'going');
        callAs(person, 'eventSwipes.record', eventId, 'going');

        assert.equal(EventSwipes.collection.find({ userId: person, eventId }).count(), 1);
        assert.deepEqual(actionsOn(eventId), ['rsvp_going']);
      });
    });

    describe('eventSwipes.remove', function () {
      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'eventSwipes.remove', makeEvent())), 'not-logged-in');
      });

      it('refuses an action it does not recognise, the old unsaved included', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'going');

        assert.equal(errorFrom(() => callAs(person, 'eventSwipes.remove', eventId, 'unsaved')), 'invalid-action');
        assert.equal(errorFrom(() => callAs(person, 'eventSwipes.remove', eventId, 'deleted')), 'invalid-action');
        assert.equal(swipeOn(eventId).decision, 'going', 'a refused call removes nothing');
      });

      /**
       * What the recommender keeps is whether the person is going. A rewind in
       * the deck and "Not going" on a page both end the RSVP, so both are
       * 'rsvp_canceled'; which of them it was survives as the reason.
       */
      ['undo', 'rsvp_canceled', 'correction'].forEach(action => {
        it(`records a going row removed by ${action} as a cancelled RSVP`, function () {
          const eventId = makeEvent();
          callAs(person, 'eventSwipes.record', eventId, 'going');
          callAs(person, 'eventSwipes.remove', eventId, action);

          assert.isUndefined(swipeOn(eventId));
          assert.deepEqual(actionsOn(eventId), ['rsvp_canceled', 'rsvp_going']);
          assert.deepEqual(interactionOn(eventId, 'rsvp_canceled').context, { reason: action });
        });
      });

      it('records a removed pass under the action that removed it', function () {
        const undone = makeEvent();
        const corrected = makeEvent();
        callAs(person, 'eventSwipes.record', undone, 'passed');
        callAs(person, 'eventSwipes.record', corrected, 'passed');
        callAs(person, 'eventSwipes.remove', undone);
        callAs(person, 'eventSwipes.remove', corrected, 'correction');

        assert.deepEqual(actionsOn(undone), ['passed', 'undo']);
        assert.deepEqual(actionsOn(corrected), ['correction', 'passed']);
      });

      it('does not invent a cancelled RSVP for an event that was only passed on', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.record', eventId, 'passed');
        callAs(person, 'eventSwipes.remove', eventId, 'rsvp_canceled');

        assert.isUndefined(swipeOn(eventId));
        assert.deepEqual(actionsOn(eventId), ['correction', 'passed']);
      });

      it('says nothing when there was no swipe to remove', function () {
        const eventId = makeEvent();
        callAs(person, 'eventSwipes.remove', eventId);
        assert.deepEqual(actionsOn(eventId), []);
      });

      /**
       * The rewind used to put the group's card back on the deck and leave the
       * person in the group: the visible half of the swipe was undone and the
       * half that mattered was not.
       */
      it('takes back the join when a right swipe on a group is undone', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');
        assert.equal(ProfileClubs.collection.find({ userId: person, clubId }).count(), 1);

        callAs(person, 'eventSwipes.remove', clubId, 'undo');

        assert.isUndefined(swipeOn(clubId));
        assert.equal(ProfileClubs.collection.find({ userId: person, clubId }).count(), 0, 'an undone join is undone');
        assert.deepEqual(actionsOn(clubId), ['joined_group', 'left_group']);
      });

      it('leaves everyone else in the group when one person undoes their join', function () {
        const clubId = makeClub();
        const other = makeUser();
        callAs(other, 'profileClubs.add', clubId);
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        callAs(person, 'eventSwipes.remove', clubId, 'undo');

        assert.equal(ProfileClubs.collection.find({ userId: other, clubId }).count(), 1);
      });

      it('does not end a membership when a joined row is removed for any other reason', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        callAs(person, 'eventSwipes.remove', clubId, 'correction');

        assert.isUndefined(swipeOn(clubId));
        assert.equal(ProfileClubs.collection.find({ userId: person, clubId }).count(), 1);
        assert.deepEqual(actionsOn(clubId), ['joined_group'], 'the row said nothing, so removing it retracts nothing');
      });

      it('does not end a membership when a pass on the group is undone', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'passed', 'club');

        callAs(person, 'eventSwipes.remove', clubId, 'undo');

        assert.equal(ProfileClubs.collection.find({ userId: person, clubId }).count(), 1);
        assert.deepEqual(actionsOn(clubId), ['joined_group', 'passed', 'undo']);
      });
    });

    /**
     * "Leave" on a page and the deck's rewind share one way out. The rewind
     * removes the swipe itself; "Leave" used to keep it, so the row went on
     * saying 'joined' about a group the person had left, and the deck — which
     * never deals a group with a swipe on it — could not offer it again.
     */
    describe('leaving a group from a page', function () {
      it('takes the joined swipe away with the membership', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        callAs(person, 'profileClubs.remove', clubId);

        assert.equal(ProfileClubs.collection.find({ userId: person, clubId }).count(), 0);
        assert.isUndefined(swipeOn(clubId), 'nothing is left saying joined');
        assert.deepEqual(actionsOn(clubId), ['joined_group', 'left_group'], 'leaving is said once');
      });

      it('finds the swipe when the group is named by its number', function () {
        const clubId = makeClub({ clubID: 4242 });
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'joined', 'club');

        callAs(person, 'profileClubs.remove', 4242);

        assert.isUndefined(swipeOn(clubId));
      });

      it('leaves a pass on the group where it was', function () {
        const clubId = makeClub();
        callAs(person, 'profileClubs.add', clubId);
        callAs(person, 'eventSwipes.record', clubId, 'passed', 'club');

        callAs(person, 'profileClubs.remove', clubId);

        assert.equal(swipeOn(clubId).decision, 'passed');
      });

      it('leaves everyone else’s joined swipe alone', function () {
        const clubId = makeClub();
        const other = makeUser();
        [other, person].forEach(userId => {
          callAs(userId, 'profileClubs.add', clubId);
          callAs(userId, 'eventSwipes.record', clubId, 'joined', 'club');
        });

        callAs(person, 'profileClubs.remove', clubId);

        assert.equal(EventSwipes.collection.find({ userId: other, eventId: clubId, decision: 'joined' }).count(), 1);
      });
    });

    describe('eventSwipes.clearPassed', function () {
      it('refuses a signed-out caller', function () {
        assert.equal(errorFrom(() => callAs(null, 'eventSwipes.clearPassed')), 'not-logged-in');
      });

      /**
       * "Bring back passed" is offered beside the deck with a count of passes.
       * An RSVP or a membership going with them would be a silent loss of the
       * two things in this collection a person actually cares about.
       */
      it('clears passes and nothing else', function () {
        const goingTo = makeEvent();
        const passedEvent = makeEvent();
        const joinedClub = makeClub();
        const passedClub = makeClub();
        callAs(person, 'eventSwipes.record', goingTo, 'going');
        callAs(person, 'eventSwipes.record', passedEvent, 'passed');
        callAs(person, 'profileClubs.add', joinedClub);
        callAs(person, 'eventSwipes.record', joinedClub, 'joined', 'club');
        callAs(person, 'eventSwipes.record', passedClub, 'passed', 'club');

        callAs(person, 'eventSwipes.clearPassed');

        assert.sameMembers(
          EventSwipes.collection.find({ userId: person }).map(swipe => swipe.decision),
          ['going', 'joined'],
        );
        assert.equal(ProfileClubs.collection.find({ userId: person, clubId: joinedClub }).count(), 1);
        assert.deepEqual(actionsOn(passedEvent), ['correction', 'passed']);
        assert.deepEqual(actionsOn(passedClub), ['correction', 'passed']);
        assert.deepEqual(actionsOn(goingTo), ['rsvp_going'], 'a standing RSVP is not touched');
      });

      it('clears only the caller’s passes', function () {
        const eventId = makeEvent();
        const other = makeUser();
        callAs(other, 'eventSwipes.record', eventId, 'passed');
        callAs(person, 'eventSwipes.record', eventId, 'passed');

        callAs(person, 'eventSwipes.clearPassed');

        assert.equal(EventSwipes.collection.find({ userId: other, eventId }).count(), 1);
      });
    });
  });
}
