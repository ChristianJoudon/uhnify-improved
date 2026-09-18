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

/**
 * The situation report: what the island looks like right now, area by area,
 * with a date on it and a source under every claim.
 *
 * Modelled on the guide the owner wrote for Lowell — a page that answers, in
 * this order, "what is the position", "what is it like where I am going",
 * "what happens over the next few weeks", "the questions everyone asks", and
 * "where the official word is" — with the branding, the properties and the
 * reservations left out. The header is one document; everything under it is
 * a flat list of items that each belong to a section, so an administrator
 * edits one small form at a time and the page draws the sections in a fixed
 * order. Nothing here is fetched: it is written by a person who read the
 * county's update, and it says when.
 */
export const BRIEFING_SECTIONS = Object.freeze([
  { value: 'glance', label: 'At a glance', blurb: 'The short answers.' },
  { value: 'area', label: 'By area', blurb: 'Darker means more disruption. An area’s colour does not describe any one address.' },
  { value: 'ahead', label: 'What’s ahead', blurb: 'Dated work and windows. Dates move; each says when to check again.' },
  { value: 'question', label: 'Questions', blurb: '' },
  { value: 'link', label: 'Official updates', blurb: 'Where the facts on this page come from. Check these before you go anywhere that was closed.' },
]);

export const AREA_LEVELS = Object.freeze([
  { value: 'interruptions', label: 'Local interruptions' },
  { value: 'recovering', label: 'Utilities recovering' },
  { value: 'limits', label: 'Travel limits' },
  { value: 'restricted', label: 'Restricted access' },
]);

export const HelpBriefing = {
  name: 'HelpBriefing',
  collection: new Mongo.Collection('HelpBriefing'),
  publicationName: 'help.briefing',
  id: 'current',
};

HelpBriefing.collection.attachSchema(new SimpleSchema({
  active: Boolean,
  /** "Hurricane Lowell recovery". */
  title: { type: String, optional: true, max: 120 },
  /** The position, in one or two sentences: what officials are asking of people. */
  lead: { type: String, optional: true, max: 400 },
  /** The caveat under it: "Recovery dates may change. Check again before you go." */
  note: { type: String, optional: true, max: 300 },
  updatedAt: Date,
  updatedBy: { type: String, optional: true },
}));

export const HelpBriefingItems = {
  name: 'HelpBriefingItems',
  collection: new Mongo.Collection('HelpBriefingItems'),
  publicationName: 'help.briefingItems',
};

HelpBriefingItems.collection.attachSchema(new SimpleSchema({
  section: { type: String, allowedValues: BRIEFING_SECTIONS.map(section => section.value) },
  /** Drawn in this order within the section; new items go last. */
  order: Number,
  /** glance: the topic ("Flights"); area: its name; ahead: the window
      ("October 1–31"); question: the question; link: the label. */
  title: { type: String, max: 160 },
  /** glance: the short answer ("Līhuʻe Airport is open"); area: one line of advice. */
  headline: { type: String, optional: true, max: 200 },
  /** glance: the rest; question: the answer; ahead: what to expect. */
  details: { type: String, optional: true, max: 2000 },
  /** area only. */
  level: { type: String, optional: true, allowedValues: AREA_LEVELS.map(level => level.value) },
  gettingAround: { type: String, optional: true, max: 500 },
  powerWater: { type: String, optional: true, max: 500 },
  beachesParks: { type: String, optional: true, max: 500 },
  /** ahead only: "Check again 7 and 3 days before you go." */
  recheck: { type: String, optional: true, max: 200 },
  /** link: the page itself; anything else: where this claim comes from. */
  url: { type: String, optional: true, max: 500 },
  sourceLabel: { type: String, optional: true, max: 120 },
  publicationStatus: { type: String, allowedValues: ['published', 'archived'] },
  createdAt: Date,
  updatedAt: Date,
  updatedBy: { type: String, optional: true },
}));

if (Meteor.isServer) {
  Meteor.startup(() => {
    HelpResources.collection.rawCollection().createIndex({ publicationStatus: 1, kind: 1, status: 1 })
      .catch(error => console.error('[index] HelpResources failed:', error.message));
    HelpBriefingItems.collection.rawCollection().createIndex({ publicationStatus: 1, section: 1, order: 1 })
      .catch(error => console.error('[index] HelpBriefingItems failed:', error.message));
  });
}
