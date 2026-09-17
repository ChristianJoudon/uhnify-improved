import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';
import { FRIEND_ACTIVITY_VISIBILITY } from '../privacy/FriendActivityPrivacy';

/**
 * What a swipe can say. A right swipe has a different name for each kind of
 * listing because it IS a different act: on an event it is an RSVP — "I'm
 * going", something friends may be shown — and on a group it is joining.
 *
 * Both used to be stored as 'interested', a word that promised neither. The
 * pages built on it disagreed about what it meant — one list called it Saved,
 * a button called it Going — and the recommender scored a join as mild
 * curiosity on top of the 'joined_group' it had already been told about. One
 * name for one thing: the stored value is the word the person reads.
 */
export const SWIPE_DECISIONS = ['going', 'joined', 'passed'];

/**
 * The only kind each right swipe fits. Nobody is "going" to a group or has
 * "joined" an event, and a row that said so would be read back to the person
 * under the wrong list. 'passed' is absent because it fits either kind.
 */
export const SWIPE_KIND_FOR_DECISION = { going: 'event', joined: 'club' };

/**
 * Each user's deck decision. The deck swipes events and, in its clubs mode,
 * groups — one collection rather than two, because a decision is a decision and
 * the unique index below already keys on the record id, which is distinct
 * across collections. `kind` says which collection to look the id up in.
 */
class EventSwipesCollection {
  constructor() {
    this.name = 'EventSwipes';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      userId: String,
      eventId: String,
      // Which decision fits which kind is a rule between two fields, so it is
      // held where both are known: 'eventSwipes.record', the one writer.
      decision: { type: String, allowedValues: SWIPE_DECISIONS },
      kind: { type: String, allowedValues: ['event', 'club'], optional: true, defaultValue: 'event' },
      friendActivityVisibility: {
        type: String,
        allowedValues: Object.values(FRIEND_ACTIVITY_VISIBILITY),
        optional: true,
        defaultValue: FRIEND_ACTIVITY_VISIBILITY.private,
      },
      createdAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);
    this.userPublicationName = `${this.name}.publication.user`;
    if (Meteor.isServer) {
      Meteor.startup(() => {
        // One decision per user per event, enforced at the database level so the
        // find-then-insert in eventSwipes.record cannot race into duplicates.
        this.collection.rawCollection().createIndex({ userId: 1, eventId: 1 }, { unique: true }).catch(error => {
          // Not swallowed. This index IS the guarantee of one swipe per person per listing —
          // without it the constraint silently does not exist, and the
          // find-then-insert guards upstream become the only thing standing
          // between two concurrent calls and a duplicate row.
          console.error('[index] failed to create; uniqueness is NOT enforced:', error.message);
        });
      });
    }
  }
}

export const EventSwipes = new EventSwipesCollection();
