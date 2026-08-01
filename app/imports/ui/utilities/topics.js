/**
 * MatchBook topic system.
 *
 * Every event and group resolves to one topic, which decides its poster colour,
 * its motif, and the icon shown beside the user's interests. Matching is by
 * keyword so it works with the existing free-text categories and member tags
 * without a schema migration.
 */

/**
 * Every field/ink pair below clears 4.5:1, so poster type stays legible at any
 * size. Dark ink wins on all the light and mid fields; only the two genuinely
 * dark fields carry cream.
 */
export const TOPICS = {
  outdoors: {
    label: 'Outdoors',
    fields: ['#3d6b61', '#457567'],
    ink: '#fff9f0',
    chip: '#dfeae7',
    chipInk: '#2f5a51',
    motif: 'outdoors',
    match: ['outdoor', 'hike', 'hiking', 'nature', 'garden', 'botan', 'beach', 'surf', 'climb', 'camp', 'sail', 'environment'],
  },
  music: {
    label: 'Music',
    fields: ['#e96d76', '#f0959a'],
    ink: '#1a1614',
    chip: '#f9dde0',
    chipInk: '#b53845',
    motif: 'music',
    match: ['music', 'concert', 'band', 'choir', 'sing', 'jam', 'karaoke', 'orchestra', 'dance', 'ballroom'],
  },
  books: {
    label: 'Books',
    fields: ['#f0e4d2', '#e3d3b8'],
    ink: '#303234',
    chip: '#f3ece0',
    chipInk: '#6b5117',
    motif: 'books',
    match: ['book', 'read', 'literature', 'writing', 'poetry', 'library', 'academic', 'scholar', 'honorary', 'debate', 'language'],
  },
  food: {
    label: 'Food & Drink',
    fields: ['#e6ae35', '#f0c869'],
    ink: '#1a1614',
    chip: '#f9ecce',
    chipInk: '#6b5117',
    motif: 'food',
    match: ['food', 'drink', 'coffee', 'dinner', 'potluck', 'cook', 'bake', 'culinary', 'nutrition'],
  },
  art: {
    label: 'Art & Design',
    fields: ['#fcc0b4', '#f7a894'],
    ink: '#303234',
    chip: '#fdece7',
    chipInk: '#a94329',
    motif: 'art',
    match: ['art', 'design', 'ceramic', 'studio', 'paint', 'draw', 'craft', 'print', 'photo', 'film', 'drama', 'theat', 'architect'],
  },
  community: {
    label: 'Community',
    fields: ['#e85020', '#f2794f'],
    ink: '#1a1614',
    chip: '#fbe0d4',
    chipInk: '#b83c14',
    motif: 'community',
    match: ['volunteer', 'service', 'cleanup', 'outreach', 'charity', 'mentor', 'fraternity', 'sorority', 'alumni'],
  },
  wellness: {
    label: 'Wellness',
    fields: ['#dfeae7', '#c9ddd6'],
    ink: '#303234',
    chip: '#dfeae7',
    chipInk: '#2f5a51',
    motif: 'wellness',
    match: ['wellness', 'yoga', 'run', 'fitness', 'health', 'medit', 'sport', 'ball', 'athlet', 'recreation', 'medic', 'nursing'],
  },
  night: {
    label: 'Nightlife',
    fields: ['#2f3b47', '#44525f'],
    ink: '#fff9f0',
    chip: '#e2e9ed',
    chipInk: '#42525f',
    motif: 'night',
    match: ['night', 'trivia', 'party', 'evening', 'game', 'chess', 'anime', 'gaming'],
  },
};

export const TOPIC_KEYS = Object.keys(TOPICS);

const FALLBACK_ORDER = ['community', 'art', 'books', 'wellness', 'food', 'music', 'outdoors', 'night'];

const stableIndex = (seed, length) => {
  let value = 0;
  const text = String(seed || '');
  for (let i = 0; i < text.length; i++) {
    value = (value * 31 + text.charCodeAt(i)) % 9973;
  }
  return value % length;
};

/**
 * Resolve a topic. Sources are tried in the order given, so a club's own
 * categories and tags outrank generic words in its name — otherwise every
 * "… Club" would land in the same bucket and the wall turns monochrome.
 * Falls back to a stable per-item choice so unmatched items still vary.
 */
export const topicFor = (...sources) => {
  const groups = sources.map(source => [source].flat().filter(Boolean).join(' ').toLowerCase());
  const seed = groups.join(' ');
  const hit = groups.reduce((found, haystack) => (
    found || (haystack ? TOPIC_KEYS.find(key => TOPICS[key].match.some(word => haystack.includes(word))) : null)
  ), null);
  const key = hit || FALLBACK_ORDER[stableIndex(seed, FALLBACK_ORDER.length)];
  const topic = TOPICS[key];
  // Two verified shades per topic: a directory where one category dominates
  // still reads with rhythm instead of as a wall of one colour.
  return { key, ...topic, field: topic.fields[stableIndex(`${seed}~`, topic.fields.length)] };
};

/** Icon + colour for one of the user's stated interests. */
export const interestMeta = interest => topicFor(interest);
