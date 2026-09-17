import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

/**
 * The index that keeps two people from ever holding one made-up name.
 *
 * Sparse, because a profile has no name until it is first needed and every
 * one of those would otherwise collide on "none". Kept here as data because
 * two places build it and must build the same one: the startup below, the way
 * every collection declares its indexes, and api/privacy/anonymousNames.js,
 * which WAITS for it before it hands out a name. The seeding in Mongo.js runs
 * while the server's files are still loading, ahead of every startup hook, so
 * a backfill that did not wait would name people with nothing yet holding the
 * names apart — and the index could then never be built over its duplicates.
 */
export const ANONYMOUS_NAME_INDEX = Object.freeze({
  keys: { anonymousName: 1 },
  options: { unique: true, sparse: true },
});

/** Encapsulates user profile data separate from Meteor account records. */
class ProfilesCollection {
  constructor() {
    this.name = 'ProfilesCollection';
    this.collection = new Mongo.Collection(this.name);
    this.schema = new SimpleSchema({
      UH_ID: { type: SimpleSchema.Integer, optional: true },
      userId: { type: String, optional: true },
      email: { type: String, index: true, unique: true },
      firstName: { type: String, optional: true },
      lastName: { type: String, optional: true },
      bio: { type: String, optional: true },
      title: { type: String, optional: true },
      picture: { type: String, optional: true },
      interests: { type: Array, optional: true },
      'interests.$': String,
      /**
       * Whether friends may be shown where this person is going and what they
       * join. Optional, and absent means NO: sharing is something a person
       * turns on, so an account from before the setting existed, or one that
       * has never opened Customize, shares nothing. Only `true` shares — every
       * reader compares against it exactly, so no other stored value can be
       * mistaken for consent.
       *
       * Written only by 'Profiles.setFriendActivitySharing', which also
       * rewrites the person's existing rows. The people directory lists its
       * fields by name, so no other member is ever sent this one.
       */
      friendActivitySharing: { type: Boolean, optional: true },
      /**
       * Who this person is inside an anonymous group: "Sleepy Honu". One
       * name each, the same in every anonymous group, for good.
       *
       * Written only by api/privacy/anonymousNames.js, on the server, from a
       * keyed hash of the account's id; read that file for why it is keyed
       * and why the answer is stored rather than worked out each time. No
       * method takes it from a browser: 'Profiles.update' lists the fields it
       * accepts, and this is not one.
       *
       * Three readers, and the list is meant to stay that short. The person
       * themself, on their own profile. Whoever runs a group they joined
       * WHILE it was anonymous, through 'clubs.members', with nothing beside
       * it that says who they are — and never for a membership that same
       * owner could once read by name, which would be the name given away in
       * every other group. And an administrator, whose profile publication
       * sends the whole document — the one place a name can be traced to an
       * account. The people directory lists its fields by name, so it never
       * sends this one; if it did, every name would be a label on a face.
       */
      anonymousName: { type: String, optional: true },
      /**
       * When this was made and when it last changed.
       *
       * Both optional, because the register's imported records predate them
       * and a required field would reject every seeded document. Absent means
       * "from before we recorded it", which is honest; a backfilled guess
       * would not be.
       *
       * The audit trail says who changed what and when. These say it on the
       * document itself, which is what answers "is this listing stale?"
       * without a join.
       */
      createdAt: { type: Date, optional: true },
      updatedAt: { type: Date, optional: true },
    });
    this.collection.attachSchema(this.schema);

    if (Meteor.isServer) {
      Meteor.startup(() => {
        this.collection.rawCollection().createIndex(ANONYMOUS_NAME_INDEX.keys, ANONYMOUS_NAME_INDEX.options).catch(error => {
          // The code and never the message: a duplicate-key message quotes the
          // value it tripped on, and a made-up name goes in no log.
          console.error(`[index] Profiles anonymousName failed; no made-up name will be given out until it is built: ${error.code || error.name}`);
        });
      });
    }

    this.userPublicationName = `${this.name}.publication.user`;
    this.adminPublicationName = `${this.name}.publication.admin`;
  }
}

export const Profiles = new ProfilesCollection();
