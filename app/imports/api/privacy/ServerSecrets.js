import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';

/**
 * Secrets the server makes for itself and tells nobody.
 *
 * One row per secret, keyed by what it is for, holding random bytes that were
 * generated here on first need. They live in the database rather than in a
 * settings file because a settings file is something a person has to write,
 * keep, and not lose: a value that nobody ever had to choose cannot be
 * forgotten on the next deploy, and it moves with the data it protects — a
 * restored backup still opens with the key that made it.
 *
 * This collection is NEVER published, has no methods, and takes nothing from a
 * browser. Meteor gives every collection an insert, an update and a remove
 * that a client can call, refused by default for want of an `allow` rule; this
 * one is made without them, so there is no door to leave unlocked. It exists
 * on the server only: Methods.js runs on both sides and reaches this file
 * through anonymousNames.js, and a browser that loads it gets no collection at
 * all — not even the empty local one a photo store leaves behind.
 *
 * No schema, as with Counters: the only writer is `serverSecret` below.
 */
class ServerSecretsCollection {
  constructor() {
    this.name = 'ServerSecrets';
    this.collection = Meteor.isServer
      ? new Mongo.Collection(this.name, { defineMutationMethods: false })
      : null;
  }
}

export const ServerSecrets = new ServerSecretsCollection();

/** The database saying "that one is taken", however the driver of the day
    spells it. Shared with anonymousNames.js, which meets the same answer. */
export const isDuplicateKey = error => error?.code === 11000 || /E11000/.test(`${error?.message}`);

/**
 * The secret kept under `name`, made by `generate` if there is none yet.
 *
 * Two server processes can both find nothing and both generate. The row's _id
 * is its name, so only one insert lands; the other is told so by the database,
 * throws its own value away and reads the one that won. What must never
 * happen is two processes each hashing with a secret of their own.
 */
export const serverSecret = (name, generate) => {
  const kept = () => ServerSecrets.collection.findOne(name)?.value;
  const existing = kept();
  if (existing) {
    return existing;
  }
  try {
    const value = generate();
    ServerSecrets.collection.insert({ _id: name, value, createdAt: new Date() });
    return value;
  } catch (error) {
    if (!isDuplicateKey(error)) {
      throw error;
    }
    return kept();
  }
};
