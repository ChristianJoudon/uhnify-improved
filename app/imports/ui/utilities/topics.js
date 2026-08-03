/**
 * MatchBook topics — the one place a subject is defined.
 *
 * A topic owns everything that follows from "what kind of thing is this":
 * its name, its one-line promise, its cover art, the pastel field and motif a
 * poster is drawn in, and the vocabulary that resolves a record to it. Adding a
 * ninth topic means adding one entry here and one image; nothing downstream
 * needs to know it happened, because no club or event carries its own artwork —
 * it inherits the topic's.
 *
 * `match` is the register's own category vocabulary, not a guess. Every value
 * that appears in the imported dataset resolves to exactly one topic.
 */

import { normalizeCategories } from './helpers';

const wash = (from, to) => `linear-gradient(165deg, ${from} 0%, ${to} 100%)`;

const ART = '/images/topics';

export const TOPICS = {
  outdoors: {
    label: 'Move & Explore',
    tagline: 'Fresh air. Good company.',
    poster: `${ART}/move-explore.jpg`,
    fields: [wash('#e6f0e8', '#cfe3d6'), wash('#e2efe6', '#d3e6d9')],
    ink: '#303234',
    chip: '#e6f0e8',
    chipInk: '#2f5a51',
    motif: 'outdoors',
    match: ['outdoor', 'outdoors', 'hiking', 'hike', 'camping', 'beach', 'running', 'run',
      'fitness', 'yoga', 'sports', 'sport', 'golf', 'watersports', 'stand_up_paddle',
      'paddle', 'surf', 'surfing', 'environment', 'sustainability', 'nature'],
  },
  music: {
    label: 'Music & Performance',
    tagline: 'Hear it live. Join in.',
    poster: `${ART}/music-performance.jpg`,
    fields: [wash('#fde3e7', '#f8ccd6'), wash('#fde7e9', '#f9d2d9')],
    ink: '#303234',
    chip: '#fde3e7',
    chipInk: '#a2434f',
    motif: 'music',
    match: ['music', 'performance', 'dance', 'hula', 'karaoke', 'open_mic', 'concert',
      'band', 'choir', 'theater', 'theatre', 'comedy', 'fire_show', 'parade', 'ukulele'],
  },
  books: {
    label: 'Books & Ideas',
    tagline: 'Read. Talk. Learn.',
    poster: `${ART}/books-ideas.jpg`,
    fields: [wash('#f9efe3', '#f0e0cc'), wash('#faf0e6', '#f2e3d0')],
    ink: '#303234',
    chip: '#f9efe3',
    chipInk: '#6b5117',
    motif: 'books',
    match: ['books', 'book', 'reading', 'writing', 'poetry', 'learning', 'education',
      'lecture', 'discussion', 'history', 'storytime', 'literacy', 'math', 'college',
      'student', 'school', 'public_speaking', 'library'],
  },
  food: {
    label: 'Food & Markets',
    tagline: 'Local bites. Good wandering.',
    poster: `${ART}/food-markets.jpg`,
    fields: [wash('#fdf0d8', '#f8e2b8'), wash('#fdf2dd', '#f9e6c2')],
    ink: '#303234',
    chip: '#fdf0d8',
    chipInk: '#6b5117',
    motif: 'food',
    match: ['food', 'food_drink', 'market', 'farmers_market', 'craft_market', 'shopping',
      'agriculture', 'beer', 'cooking', 'potluck', 'dinner', 'coffee'],
  },
  art: {
    label: 'Make & Create',
    tagline: 'Hands-on. Curious. Expressive.',
    poster: `${ART}/make-create.jpg`,
    fields: [wash('#fde6dd', '#fbd2c4'), wash('#fde9e1', '#fbd7ca')],
    ink: '#303234',
    chip: '#fde6dd',
    chipInk: '#a34b2c',
    motif: 'art',
    match: ['art', 'arts_crafts', 'arts_culture', 'visual_art', 'craft', 'crafts',
      'printmaking', 'quilting', 'exhibition', 'exhibitions', 'workshop', 'workshops',
      'film', 'photography', 'fashion', 'design', 'culture', 'technology', 'robotics', 'lego'],
  },
  community: {
    label: 'Community & Causes',
    tagline: 'Show up. Pitch in.',
    poster: `${ART}/community-causes.jpg`,
    fields: [wash('#fde7db', '#fbd4c0'), wash('#fdeae0', '#fbd9c8')],
    ink: '#303234',
    chip: '#fde7db',
    chipInk: '#a04d28',
    motif: 'community',
    match: ['community', 'volunteer', 'service', 'advocacy', 'fundraiser', 'donation',
      'reuse', 'civic', 'veterans', 'lgbtq', 'women', 'youth', 'seniors', 'kupuna',
      'networking', 'business', 'professional', 'leadership', 'conference', 'spirituality'],
  },
  wellness: {
    label: 'Plants & Home',
    tagline: 'Swap. Grow. Gather.',
    poster: `${ART}/plants-home.jpg`,
    fields: [wash('#e8f1ef', '#d5e6e2'), wash('#eaf2f0', '#d9e9e5')],
    ink: '#303234',
    chip: '#e8f1ef',
    chipInk: '#2f5a51',
    motif: 'wellness',
    match: ['garden', 'gardening', 'plants', 'plant', 'home', 'health', 'health_wellness',
      'community_health', 'healthcare', 'wellness', 'mental_health', 'support_group',
      'support', 'sound_bath', 'meditation', 'playgroup', 'early_childhood', 'family',
      'safety'],
  },
  night: {
    label: 'Nights Out',
    tagline: 'Good people. Great nights.',
    poster: `${ART}/nights-out.jpg`,
    fields: [wash('#e8edf3', '#d4dde8'), wash('#eaeff4', '#d8e1ea')],
    ink: '#303234',
    chip: '#e8edf3',
    chipInk: '#42525f',
    motif: 'night',
    match: ['night', 'nightlife', 'night_market', 'games', 'game', 'trivia', 'social',
      'festival', 'holiday', 'party', 'bingo', 'mixer', 'club'],
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
    label: hit ? topic.label : 'Community & Causes',
    // Two verified washes per topic: a directory where one category dominates
    // still reads with rhythm instead of as a wall of one colour.
    field: topic.fields[stableIndex(`${seed}~`, topic.fields.length)],
  };
};

/**
 * One resolution per kind, so a record cannot be one topic on its card and
 * another in the filter that surfaced it — or on the sheet that opens from it.
 * Both readings existed side by side before this and disagreed whenever an
 * event carried categories of its own.
 *
 * An event is named for what it is, so its own words lead; a club is named for
 * who it is, so its categories do.
 *
 * The host is deliberately not a source. It used to be the fallback for an
 * event named after a person, but every imported event carries categories of
 * its own, and reading the host on some pages and not others gave one event two
 * colours. Both the order and the content of these sources are load-bearing:
 * the first group to match wins, and all of them together seed which of the
 * topic's two washes gets drawn.
 */
export const topicForEvent = event => topicFor(
  event.title,
  event.description,
  normalizeCategories(event.categories),
);

export const topicForClub = club => topicFor(
  normalizeCategories(club.categories),
  club.tags,
  club.name,
  club.description,
);

/** Icon + colour for one of the user's stated interests. */
export const interestMeta = interest => topicFor(interest);
