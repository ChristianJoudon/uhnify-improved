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
    match: ['outdoor', 'outdoors', 'hike', 'hiking', 'nature', 'garden', 'gardening', 'botanical', 'beach',
      'surf', 'surfing', 'climb', 'climbing', 'camping', 'sailing', 'environmental', 'conservation'],
  },
  music: {
    label: 'Music',
    fields: ['#e96d76', '#f0959a'],
    ink: '#1a1614',
    chip: '#f9dde0',
    chipInk: '#b53845',
    motif: 'music',
    match: ['music', 'musical', 'concert', 'band', 'choir', 'chorus', 'singing', 'karaoke', 'orchestra',
      'dance', 'dancing', 'ballroom', 'jazz', 'glee'],
  },
  books: {
    label: 'Books',
    fields: ['#f0e4d2', '#e3d3b8'],
    ink: '#303234',
    chip: '#f3ece0',
    chipInk: '#6b5117',
    motif: 'books',
    // Deliberately no 'academic'/'professional': in this directory they are a
    // filing bucket, not a subject, and matching them put half the wall in one
    // colour while telling the user nothing.
    match: ['book', 'books', 'reading', 'literature', 'literary', 'writing', 'poetry', 'library',
      'scholarly', 'honorary', 'debate', 'language', 'linguistics', 'philosophy', 'history'],
  },
  food: {
    label: 'Food & Drink',
    fields: ['#e6ae35', '#f0c869'],
    ink: '#1a1614',
    chip: '#f9ecce',
    chipInk: '#6b5117',
    motif: 'food',
    match: ['food', 'drink', 'drinks', 'coffee', 'dinner', 'potluck', 'cooking', 'baking', 'culinary', 'nutrition', 'dietetics'],
  },
  art: {
    label: 'Art & Design',
    fields: ['#fcc0b4', '#f7a894'],
    ink: '#303234',
    chip: '#fdece7',
    chipInk: '#a94329',
    motif: 'art',
    match: ['art', 'arts', 'design', 'ceramics', 'studio', 'painting', 'drawing', 'craft', 'crafts',
      'printmaking', 'photography', 'film', 'drama', 'theatre', 'theater', 'architects', 'architecture', 'graphic'],
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
    match: ['wellness', 'yoga', 'running', 'fitness', 'health', 'meditation', 'sport', 'sports',
      'basketball', 'volleyball', 'football', 'soccer', 'athletic', 'athletics', 'recreational',
      'medical', 'medicine', 'nursing', 'therapy'],
  },
  night: {
    label: 'Nightlife',
    fields: ['#2f3b47', '#44525f'],
    ink: '#fff9f0',
    chip: '#e2e9ed',
    chipInk: '#42525f',
    motif: 'night',
    match: ['night', 'nightlife', 'trivia', 'party', 'evening', 'game', 'games', 'gaming', 'chess', 'anime', 'manga', 'esports'],
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
// Whole-word matching. Substring matching quietly mis-tagged real entries —
// "campus" hit `camp`, "party" hit `art`, "nursing" hit `sing` — which both
// mislabelled clubs and made later keywords unreachable.
const words = text => text.toLowerCase().split(/[^a-z]+/).filter(Boolean);

export const topicFor = (...sources) => {
  const groups = sources.map(source => words([source].flat().filter(Boolean).join(' ')));
  const seed = groups.flat().join(' ');
  const hit = groups.reduce((found, tokens) => {
    if (found || tokens.length === 0) {
      return found;
    }
    const bag = new Set(tokens);
    return TOPIC_KEYS.find(key => TOPICS[key].match.some(word => bag.has(word))) || null;
  }, null);
  const key = hit || FALLBACK_ORDER[stableIndex(seed, FALLBACK_ORDER.length)];
  const topic = TOPICS[key];
  return {
    key,
    ...topic,
    // Unmatched items still get a varied field, but they must not claim a
    // subject they were never matched on.
    matched: Boolean(hit),
    label: hit ? topic.label : 'Group',
    // Two verified shades per topic: a directory where one category dominates
    // still reads with rhythm instead of as a wall of one colour.
    field: topic.fields[stableIndex(`${seed}~`, topic.fields.length)],
  };
};

/** Icon + colour for one of the user's stated interests. */
export const interestMeta = interest => topicFor(interest);
