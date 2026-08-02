import { Meteor } from 'meteor/meteor';

/**
 * MatchBook departments — an edited contents page for a directory that cannot
 * edit itself.
 *
 * `categories` is fifteen free-text values: one of them is 39% of the whole
 * directory, nine resolve to one or two groups, and the sports family is split
 * across six near-duplicates. We do not migrate the data; we file each raw
 * label under a department the way a contents page files pieces, and the raw
 * label survives one click deeper.
 *
 * Three vocabularies have to be covered or a club falls off the index:
 *   1. the fifteen values living in the collection today
 *   2. CLUB_CATEGORY_OPTIONS in helpers.js — the admin/legacy list
 *   3. the eight TOPICS labels — AddClub stores TOPICS[key].label as the club's
 *      category, so those strings really are category values in production
 *
 * `topic` names a TOPICS key used for COLOUR ONLY — the folio wash and the
 * weight rule. No department resolves a club's topic.
 */
export const DEPARTMENTS = [
  {
    folio: '01',
    key: 'study',
    label: 'Study & Career',
    topic: 'books',
    note: 'Majors, chapters, honours, and the pre-professional societies.',
    categories: ['Academic/Professional', 'Honorary Society', 'Technology', 'Books'],
  },
  {
    folio: '02',
    key: 'service',
    label: 'Service & Greek',
    topic: 'community',
    note: 'Volunteering, mutual aid, houses, and student government.',
    categories: ['Service', 'Fraternity/Sorority', 'Community', 'Student Affairs'],
  },
  {
    folio: '03',
    key: 'play',
    label: 'Play & Outdoors',
    topic: 'wellness',
    note: 'Courts, mats, pick-up games, and time outside.',
    categories: ['Sports', 'Sports/Leisure', 'Team Sports', 'Basketball', 'Volleyball',
      'Leisure/Recreational', 'Outdoors', 'Wellness'],
  },
  {
    folio: '04',
    key: 'culture',
    label: 'Culture & Belief',
    topic: 'music',
    note: 'Heritage, language, worship, and politics.',
    categories: ['Ethnic/Cultural', 'Cultural', 'Religious/Spiritual', 'Political'],
  },
  {
    // No clubs today, so it does not render. It is reachable rather than dead:
    // the create form writes 'Art & Design', 'Music', 'Food & Drink' and
    // 'Nightlife' verbatim, so this department appears the first time someone
    // starts a group on one of those topics.
    folio: '05',
    key: 'arts',
    label: 'Art & Evenings',
    topic: 'night',
    note: 'Making, playing, eating, and things after dark.',
    categories: ['Arts', 'Art & Design', 'Music', 'Food & Drink', 'Nightlife'],
  },
];

export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map(dept => [dept.key, dept]));

/** Lowercased category → department key, so stored capitalisation drift still files. */
export const CATEGORY_DEPT = new Map(
  DEPARTMENTS.flatMap(dept => dept.categories.map(category => [category.toLowerCase(), dept.key])),
);

/** Lowercased category → the string to print. Selection state holds the keys. */
export const KIND_LABEL = new Map(
  DEPARTMENTS.flatMap(dept => dept.categories.map(category => [category.toLowerCase(), category])),
);

/**
 * The 39% bucket, named once. This is an attribute — "is a pre-professional
 * chapter" — rather than a subject. topics.js already made that call by
 * refusing to match 'academic'/'professional' as a topic; the rail never
 * honoured it. So it gets its own axis instead of another row.
 */
export const PRE_PROFESSIONAL = new Set(['academic/professional', 'honorary society']);

/** Only consulted when nothing else claims a club. */
const TOPIC_RESCUE = {
  books: 'study',
  community: 'service',
  wellness: 'play',
  outdoors: 'play',
  art: 'arts',
  music: 'arts',
  food: 'arts',
  night: 'arts',
};

/**
 * File a club. Literal categories win; the derived topic is a rescue used only
 * when no department claims any of them — an empty field, 'Other', or novel
 * free text. Callers must pass `topic.matched ? topic.key : null`, because an
 * unmatched topic is a hash of the club's name and would file at random.
 * Returns [] for a genuinely unfilable club: it stays on the wall and stays
 * findable by search, it just has no department.
 */
export const departmentsFor = (categories = [], matchedTopicKey = null) => {
  const keys = categories.map(category => category.toLowerCase());
  const claimed = keys.filter(key => CATEGORY_DEPT.has(key));
  if (claimed.length > 0) {
    return [...new Set(claimed.map(key => CATEGORY_DEPT.get(key)))];
  }
  const rescued = matchedTopicKey ? TOPIC_RESCUE[matchedTopicKey] : null;
  if (!rescued && Meteor.isDevelopment && categories.length > 0) {
    console.warn('[departments] unfiled categories:', categories); // eslint-disable-line no-console
  }
  return rescued ? [rescued] : [];
};
