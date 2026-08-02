/**
 * MatchBook topic system.
 *
 * Every event and group resolves to one topic, which decides its poster colour,
 * its motif, and the icon shown beside the user's interests. Matching is by
 * keyword so it works with the existing free-text categories and member tags
 * without a schema migration.
 */

/**
 * Fields are soft pastel washes rather than saturated blocks — a wall of
 * posters should read as light and inviting, not as shouting colour. Each is a
 * gradient so the surface has some air in it, and every topic keeps the same
 * charcoal ink, which is what gives the design its contrast and its bite.
 * Worst-case contrast across all sixteen stops is 8.95:1.
 */
const wash = (from, to) => `linear-gradient(165deg, ${from} 0%, ${to} 100%)`;

export const TOPICS = {
  outdoors: {
    label: 'Outdoors',
    fields: [wash('#e6f0e8', '#cfe3d6'), wash('#e2efe6', '#d3e6d9')],
    ink: '#303234',
    chip: '#e6f0e8',
    chipInk: '#2f5a51',
    motif: 'outdoors',
    match: ['outdoor', 'outdoors', 'hike', 'hiking', 'nature', 'garden', 'gardening', 'botanical', 'beach',
      'surf', 'surfing', 'climb', 'climbing', 'camping', 'sailing', 'environmental', 'conservation'],
  },
  music: {
    label: 'Music',
    fields: [wash('#fde3e7', '#f8ccd6'), wash('#fde7e9', '#f9d2d9')],
    ink: '#303234',
    chip: '#fde3e7',
    chipInk: '#a2434f',
    motif: 'music',
    match: ['music', 'musical', 'concert', 'band', 'choir', 'chorus', 'singing', 'karaoke', 'orchestra',
      'dance', 'dancing', 'ballroom', 'jazz', 'glee'],
  },
  books: {
    label: 'Books',
    fields: [wash('#f9efe3', '#f0e0cc'), wash('#faf0e6', '#f2e3d0')],
    ink: '#303234',
    chip: '#f9efe3',
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
    fields: [wash('#fdf0d8', '#f8e2b8'), wash('#fdf2dd', '#f9e6c2')],
    ink: '#303234',
    chip: '#fdf0d8',
    chipInk: '#6b5117',
    motif: 'food',
    match: ['food', 'drink', 'drinks', 'coffee', 'dinner', 'potluck', 'cooking', 'baking', 'culinary', 'nutrition', 'dietetics'],
  },
  art: {
    label: 'Art & Design',
    fields: [wash('#fde6dd', '#fbd2c4'), wash('#fde9e1', '#fbd7ca')],
    ink: '#303234',
    chip: '#fde6dd',
    chipInk: '#a34b2c',
    motif: 'art',
    match: ['art', 'arts', 'design', 'ceramics', 'studio', 'painting', 'drawing', 'craft', 'crafts',
      'printmaking', 'photography', 'film', 'drama', 'theatre', 'theater', 'architects', 'architecture', 'graphic'],
  },
  community: {
    label: 'Community',
    fields: [wash('#fde7db', '#fbd4c0'), wash('#fdeae0', '#fbd9c8')],
    ink: '#303234',
    chip: '#fde7db',
    chipInk: '#a04d28',
    motif: 'community',
    // 'community' must be here: a topic's own label is stored as the club's
    // category, so it has to resolve back to the same topic on read.
    match: ['community', 'volunteer', 'service', 'cleanup', 'outreach', 'charity', 'mentor', 'fraternity', 'sorority', 'alumni'],
  },
  wellness: {
    label: 'Wellness',
    fields: [wash('#e8f1ef', '#d5e6e2'), wash('#eaf2f0', '#d9e9e5')],
    ink: '#303234',
    chip: '#e8f1ef',
    chipInk: '#2f5a51',
    motif: 'wellness',
    match: ['wellness', 'yoga', 'running', 'fitness', 'health', 'meditation', 'sport', 'sports',
      'basketball', 'volleyball', 'football', 'soccer', 'athletic', 'athletics', 'recreational',
      'medical', 'medicine', 'nursing', 'therapy'],
  },
  night: {
    label: 'Nightlife',
    fields: [wash('#e8edf3', '#d4dde8'), wash('#eaeff4', '#d8e1ea')],
    ink: '#303234',
    chip: '#e8edf3',
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
    // Two verified washes per topic: a directory where one category dominates
    // still reads with rhythm instead of as a wall of one colour.
    field: topic.fields[stableIndex(`${seed}~`, topic.fields.length)],
  };
};

/** Icon + colour for one of the user's stated interests. */
export const interestMeta = interest => topicFor(interest);
