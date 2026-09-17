import { Meteor } from 'meteor/meteor';
import moment from 'moment-timezone';

/**
 * Who a listing may be sent to, and how far back and forward events go.
 *
 * The publications and the recommender both answer "what may this person be
 * shown?", and each used to carry its own copy of the answer. The copies agreed
 * only because both were the same one line: published, and nothing else. A
 * group can now be private, and a second definition of "public" is the one
 * that gets forgotten the next time the first is changed — so there is one,
 * here, and everything that can reach somebody who is not a member reads it.
 *
 * Nothing in this file knows about a collection. It builds selectors and
 * dates, which is what lets the recommender's methods file (loaded on the
 * client as well) and the server's publications share it.
 */

export const LISTING_TIME_ZONE = 'Pacific/Honolulu';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead events are sent when nobody asked for particular dates. */
export const EVENT_HORIZON_DAYS = 120;

/**
 * The widest span a caller may ask for by name. A calendar shows a month and
 * loads the ones either side of it; three of the longest months in a row are
 * ninety-two days.
 */
export const EVENT_WINDOW_MAX_DAYS = 93;

/** Not a draft waiting for review and not archived. Absent is how every record
    older than the ingestion pipeline says "published". */
export const PUBLISHED_SELECTOR = {
  $or: [
    { publicationStatus: 'published' },
    { publicationStatus: { $exists: false } },
  ],
};

/**
 * Public: published, and either never given a visibility or given 'public'.
 *
 * Written as "absent or 'public'" rather than "not 'private'" on purpose. The
 * event schema already allows 'members' and 'unlisted', and whatever value is
 * added next will be added by somebody who is not thinking about this line.
 * Anything this selector does not recognise is not sent.
 */
export const PUBLIC_LISTING_SELECTOR = {
  $and: [
    PUBLISHED_SELECTOR,
    { $or: [{ visibility: 'public' }, { visibility: { $exists: false } }] },
  ],
};

/** The visibility half of that selector, for a record already in hand. */
export const isOpenToAll = record => Boolean(record)
  && (record.visibility === undefined || record.visibility === 'public');

/**
 * What no cursor over a group or an event carries unless it is the owner's own
 * or an administrator's.
 *
 * `owner` and `createdBy` are account names, which resolve to email addresses.
 * `inviteToken` is a capability: whoever holds it can join a private group with
 * no further question, so sending it with the listing would make every private
 * group public to anyone who opened a console.
 */
export const WITHHELD_LISTING_FIELDS = Object.freeze({
  owner: 0,
  createdBy: 0,
  inviteToken: 0,
  // Only a date, but it is the date a listing STOPPED being anonymous — which
  // tells a stranger that it once was, and roughly who joined under that
  // promise. The organizer's page reads it from the owned publication; nobody
  // else has a use for it.
  anonymousUntil: 0,
});

/**
 * Midnight this morning on Kauaʻi — the floor under every event that is sent.
 *
 * The start of the day and not the present moment, for two reasons. "On today"
 * has to go on showing the market that opened at seven when somebody looks at
 * noon. And a selector built from the clock is a different selector for every
 * subscriber, which the server must then watch separately; one built from the
 * date is identical for everyone all day, and Meteor shares a single observer
 * between them.
 *
 * Computed in the island's zone because the server's is not promised to be:
 * on a UTC host "today" would begin at two in the afternoon.
 */
export const startOfToday = (now = new Date()) => moment.tz(now, LISTING_TIME_ZONE).startOf('day').toDate();

/**
 * The dates a caller is given, from the dates they asked for.
 *
 * Nothing asked: today, and EVENT_HORIZON_DAYS on from it. A window asked for:
 * `from` is raised to today however far back it reaches, because the past is
 * not shown to anyone, and the span that is left may not exceed
 * EVENT_WINDOW_MAX_DAYS — a subscription is an open-ended promise to keep
 * sending, and "everything until 2090" is the old publication by another name.
 *
 * Returns null for a window that is entirely in the past. That is a calendar
 * turned back a month, not a mistake, and the answer is simply nothing.
 */
export const eventWindow = (asked, now = new Date()) => {
  const floor = startOfToday(now);
  if (!asked || (!asked.from && !asked.to)) {
    return { from: floor, to: new Date(floor.getTime() + EVENT_HORIZON_DAYS * DAY_MS) };
  }
  if ([asked.from, asked.to].some(date => date && Number.isNaN(date.getTime()))) {
    throw new Meteor.Error('invalid-window', 'Those dates could not be read.');
  }
  const from = asked.from && asked.from > floor ? asked.from : floor;
  const to = asked.to || new Date(from.getTime() + EVENT_WINDOW_MAX_DAYS * DAY_MS);
  if (to <= from) {
    return null;
  }
  if (to.getTime() - from.getTime() > EVENT_WINDOW_MAX_DAYS * DAY_MS) {
    throw new Meteor.Error('window-too-wide', `Events can be loaded ${EVENT_WINDOW_MAX_DAYS} days at a time.`);
  }
  return { from, to };
};

/**
 * Events not yet over on a given day: starting on or after it, or begun
 * earlier with an end that has not passed. The second half is what keeps a
 * three-day festival on the wall on its second day; an event with no endDate
 * is over, as far as anybody can tell, when the day it started on is.
 *
 * With no far end, this is for the cursors that are small by nature — one
 * group's events, one person's own — where a horizon would only hide next
 * year's retreat from the people organizing it.
 */
export const eventsFrom = from => ({ $or: [{ date: { $gte: from } }, { endDate: { $gte: from } }] });

/** The same, and starting before the window closes. */
export const eventsWithin = ({ from, to }) => ({ $and: [{ date: { $lt: to } }, eventsFrom(from)] });
