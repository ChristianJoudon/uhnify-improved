import { Meteor } from 'meteor/meteor';
import { Mongo } from 'meteor/mongo';
import SimpleSchema from 'simpl-schema';

/* eslint-disable no-console */

/**
 * Where to find help — water, food, a shelter, a place to charge a phone —
 * and the switch that puts it in front of everyone.
 *
 * Built for the week after Hurricane Lowell, when the question on the island
 * was not "what is on" but "where is the water". A resource is a place and a
 * fact about it: what it gives, where, when, whether it is open, when somebody
 * last checked. Administrators post them in seconds, because when it matters
 * most nobody is waiting for a scraper. The page is public and light: no
 * sign-in, no map tiles, a list a phone on one bar can load.
 */

export const RESOURCE_KINDS = Object.freeze([
  { value: 'water', label: 'Water', blurb: 'Drinking water and distribution points' },
  { value: 'food', label: 'Food', blurb: 'Meals, food banks, distribution' },
  { value: 'shelter', label: 'Shelter', blurb: 'Emergency and overnight shelters' },
  { value: 'medical', label: 'Medical', blurb: 'Clinics, pharmacies, first aid' },
  { value: 'ice', label: 'Ice', blurb: 'Ice for medicine and food' },
  { value: 'charging', label: 'Charging', blurb: 'Power and phone charging' },
  { value: 'fuel', label: 'Fuel', blurb: 'Fuel that is open' },
  { value: 'supplies', label: 'Supplies', blurb: 'Tarps, cleanup kits, hygiene' },
  { value: 'info', label: 'Information', blurb: 'Where to ask, and answers to common questions' },
]);

export const RESOURCE_STATUSES = Object.freeze(['open', 'closed', 'unknown']);

export const HelpResources = {
  name: 'HelpResources',
  collection: new Mongo.Collection('HelpResources'),
  publicationName: 'help.resources',
};

HelpResources.collection.attachSchema(new SimpleSchema({
  kind: { type: String, allowedValues: RESOURCE_KINDS.map(kind => kind.value) },
  /** "Kapaʻa Neighborhood Center", or for 'info' the question itself. */
  name: { type: String, max: 160 },
  /** What is given, in what quantity, to whom; for 'info' the answer. */
  details: { type: String, optional: true, max: 2000 },
  location: { type: String, optional: true, max: 240 },
  region: { type: String, optional: true, max: 80 },
  /** "Daily 8 AM–4 PM", "Tuesday and Thursday only". */
  hours: { type: String, optional: true, max: 200 },
  status: { type: String, allowedValues: RESOURCE_STATUSES },
  /** Who says so, and where — a county release, the Red Cross page. */
  source: { type: Object, optional: true },
  'source.publisher': { type: String, optional: true, max: 120 },
  'source.url': { type: String, optional: true, max: 500 },
  /** When a person last confirmed this is still true. Drawn on the page. */
  verifiedAt: { type: Date, optional: true },
  publicationStatus: { type: String, allowedValues: ['published', 'archived'] },
  createdAt: Date,
  updatedAt: Date,
  updatedBy: { type: String, optional: true },
}));

/** One document, _id 'current': whether the island is in an emergency and
    what the banner on every page should say. */
export const EmergencyState = {
  name: 'EmergencyState',
  collection: new Mongo.Collection('EmergencyState'),
  publicationName: 'help.emergency',
  id: 'current',
};

EmergencyState.collection.attachSchema(new SimpleSchema({
  active: Boolean,
  headline: { type: String, optional: true, max: 120 },
  message: { type: String, optional: true, max: 500 },
  updatedAt: Date,
  updatedBy: { type: String, optional: true },
}));

if (Meteor.isServer) {
  Meteor.startup(() => {
    HelpResources.collection.rawCollection().createIndex({ publicationStatus: 1, kind: 1, status: 1 })
      .catch(error => console.error('[index] HelpResources failed:', error.message));
  });
}
