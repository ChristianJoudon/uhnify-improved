/**
 * MatchBook topics — the one place a subject is defined.
 *
 * A topic owns everything that follows from "what kind of thing is this":
 * its name, its one-line promise, its cover art, the illustration its cards
 * carry, the pastel field a poster is drawn in, and the vocabulary that
 * resolves a record to it. Activity illustrations are registered here too,
 * as subsections of the existing topics. That keeps one category system while
 * allowing a hiking listing and a birdwatching listing to have specific art.
 *
 * `match` is the register's own category vocabulary, not a guess. Every value
 * that appears in the imported dataset resolves to exactly one topic — AND
 * every topic's own display label resolves to itself. That second rule is not
 * decoration: Customize stores an interest as the label string, and every
 * consumer resolves it back through topicFor. Three labels used to match none
 * of their own keywords, so picking "Nights Out" as an interest resolved to
 * whatever the hash fallback happened to pick.
 */

import { normalizeCategories } from './helpers';

const wash = (from, to) => `linear-gradient(165deg, ${from} 0%, ${to} 100%)`;

const ART = '/images/topics';
/** The drawn illustration a single event or group card carries. */
const ACTIVITY_ICON = '/images/activity-icons';

const activity = (key, label, family, topicKey, filename, aliases = []) => Object.freeze({
  key,
  label,
  family,
  topicKey,
  icon: filename.startsWith('/') ? filename : `${ACTIVITY_ICON}/${filename}`,
  aliases: Object.freeze([key, label, ...aliases]),
});

/**
 * The complete supplied Activity, Event & Group icon library, plus the two
 * existing MatchBook illustrations the product owner explicitly retained for
 * generic crafts and running.
 *
 * Keys are semantic and stable; the ZIP's leading numbers were catalog order,
 * not identity. `topicKey` files each subsection into MatchBook's existing
 * public topics, so this is an extension of the category system rather than a
 * second one. Aliases include the coarser review categories already stored on
 * approved ingestion records where one icon is a sensible representative.
 */
const ACTIVITY_DEFINITIONS = Object.freeze([
  activity(
    'reading_solo',
    'Solo Reader',
    'Reading & Learning',
    'books',
    'reading-solo.png',
    ['solo reading', 'silent reading'],
  ),
  activity(
    'reading_book_club',
    'Book Club',
    'Reading & Learning',
    'books',
    'reading-book-club.png',
    ['book club', 'reading group', 'talks_discussions'],
  ),
  activity(
    'reading_storytime',
    'Storytime',
    'Reading & Learning',
    'books',
    'reading-storytime.png',
    ['story time', 'storytime_literacy', 'read aloud', 'read aloud club', 'readaloud'],
  ),
  activity(
    'writing_journaling',
    'Writing & Journaling',
    'Reading & Learning',
    'books',
    'writing-journaling.png',
    ['writing group', 'journaling', 'books_writing', 'writing', 'writer', 'writers',
      "writer's", "writer's garden", 'writer s garden', 'writers garden'],
  ),

  activity(
    'hiking_together',
    'Hiking Together',
    'Outdoors & Nature',
    'outdoors',
    'hiking-together.png',
    ['group hike', 'guided hike', 'outdoor_recreation'],
  ),
  activity(
    'hiking_boot',
    'Hiking Boot',
    'Outdoors & Nature',
    'outdoors',
    'hiking-boot.png',
    ['hiking boot', 'trail hike'],
  ),
  activity(
    'trail_marker',
    'Trail Marker',
    'Outdoors & Nature',
    'outdoors',
    'trail-marker.png',
    ['trail marker', 'trail work', 'trail maintenance'],
  ),
  activity(
    'birdwatching',
    'Birdwatching',
    'Outdoors & Nature',
    'outdoors',
    'birdwatching.png',
    ['bird watching', 'bird walk'],
  ),
  activity(
    'camping',
    'Camping',
    'Outdoors & Nature',
    'outdoors',
    'camping.png',
    ['camp out', 'campout'],
  ),
  activity(
    'nature_walk',
    'Nature Walk',
    'Outdoors & Nature',
    'outdoors',
    'nature-walk.png',
    ['nature walk', 'nature_environment'],
  ),
  activity(
    'stargazing',
    'Stargazing',
    'Outdoors & Nature',
    'outdoors',
    'stargazing.png',
    ['star gazing', 'astronomy night'],
  ),

  activity(
    'farmers_market_stall',
    'Market Stall',
    'Markets, Food & Drink',
    'food',
    'farmers-market-stall.png',
    ['farmers market', 'farmer market', 'farmers_market', 'local_market'],
  ),
  activity(
    'farmers_market_crate',
    'Produce Crate',
    'Markets, Food & Drink',
    'food',
    'farmers-market-crate.png',
    ['produce market', 'fruit market', 'vegetable market'],
  ),
  activity(
    'farmers_market_flowers',
    'Flowers & Herbs',
    'Markets, Food & Drink',
    'food',
    'farmers-market-flowers.png',
    ['flower market', 'herb market', 'flowers and herbs'],
  ),
  activity(
    'cooking_class',
    'Cooking Class',
    'Markets, Food & Drink',
    'food',
    'cooking-class.png',
    ['cooking class', 'cooking workshop', 'cooking'],
  ),
  activity(
    'baking',
    'Baking',
    'Markets, Food & Drink',
    'food',
    'baking.png',
    ['bake class', 'baking class'],
  ),
  activity(
    'coffee_meetup',
    'Coffee Meetup',
    'Markets, Food & Drink',
    'food',
    'coffee-meetup.png',
    ['coffee meetup', 'coffee meet up', 'coffee morning', 'food_drink'],
  ),
  activity(
    'picnic',
    'Picnic',
    'Markets, Food & Drink',
    'food',
    'picnic.png',
    ['community picnic', 'community_meals'],
  ),

  activity(
    'pottery',
    'Pottery',
    'Arts & Culture',
    'art',
    'pottery.png',
    ['ceramics', 'clay class'],
  ),
  activity(
    'knitting_crochet',
    'Knitting & Crochet',
    'Arts & Culture',
    'art',
    'knitting-crochet.png',
    ['knitting', 'crochet', 'fiber arts'],
  ),
  activity(
    'photography_walk',
    'Photography Walk',
    'Arts & Culture',
    'art',
    'photography-walk.png',
    ['photo walk', 'photography', 'film_photography', 'visual_art_exhibitions'],
  ),
  activity(
    'dance_class',
    'Dance Class',
    'Arts & Culture',
    'music',
    'dance-class.png',
    ['dance class', 'dance lesson', 'dance_hula', 'hula', 'hula class', 'hula lesson',
      'hula lessons'],
  ),
  activity(
    'theater',
    'Theater',
    'Arts & Culture',
    'music',
    'theater.png',
    ['theatre', 'stage play', 'theater_comedy'],
  ),
  activity(
    'live_music',
    'Live Music',
    'Arts & Culture',
    'music',
    'live-music.png',
    ['concert', 'live performance'],
  ),
  activity(
    'choir',
    'Choir',
    'Arts & Culture',
    'music',
    'choir.png',
    ['chorus', 'choral'],
  ),
  activity(
    'craft_circle',
    'Arts & Crafts',
    'Arts & Culture',
    'art',
    '/images/motifs/art.png',
    ['craft', 'crafts', 'craft group', 'craft circle', 'craft fair', 'craft market',
      'made craft', 'arts_crafts'],
  ),
  activity(
    'patchwork',
    'Patchwork & Quilting',
    'Arts & Culture',
    'art',
    'craft-circle.png',
    ['patchwork', 'quilting bee', 'quilt circle'],
  ),

  activity(
    'yoga_stretch',
    'Yoga & Stretching',
    'Wellbeing & Family',
    'wellness',
    'yoga-stretch.png',
    ['yoga', 'stretching', 'yoga_meditation', 'lululemon', 'sunday sweat'],
  ),
  activity(
    'cycling',
    'Cycling',
    'Movement & Water',
    'outdoors',
    'cycling.png',
    ['bike ride', 'bicycle ride'],
  ),
  activity(
    'surfing',
    'Surfing',
    'Movement & Water',
    'outdoors',
    'surfing.png',
    ['surf lesson', 'surf club'],
  ),
  activity(
    'paddling',
    'Paddling',
    'Movement & Water',
    'outdoors',
    'paddling.png',
    ['canoe', 'kayak', 'water_sports'],
  ),
  activity(
    'swimming',
    'Swimming',
    'Movement & Water',
    'outdoors',
    'swimming.png',
    ['swim class', 'ocean swim'],
  ),
  activity(
    'fitness_class',
    'Fitness Class',
    'Movement & Water',
    'outdoors',
    'fitness-class.png',
    ['group fitness', 'exercise class', 'fitness_movement', 'health_wellness'],
  ),
  activity(
    'running',
    'Running',
    'Movement & Water',
    'outdoors',
    '/images/motifs/running-spare.png',
    ['run club', 'fun run', 'road race', 'marathon', 'half marathon', '5k', '10k'],
  ),

  activity(
    'card_games',
    'Card Games',
    'Social & Games',
    'night',
    'card-games.png',
    ['card game', 'cards night', 'games_trivia', 'bridge', 'mahjong', 'mah jong'],
  ),
  activity(
    'chess_club',
    'Chess Club',
    'Social & Games',
    'night',
    'chess-club.png',
    ['chess night', 'chess tournament'],
  ),
  activity(
    'movie_night',
    'Movie Night',
    'Social & Games',
    'night',
    'movie-night.png',
    ['film night', 'community movie', 'movie screening', 'screening', 'picture show',
      'rocky horror'],
  ),
  activity(
    'karaoke',
    'Karaoke',
    'Social & Games',
    'music',
    'karaoke.png',
    ['karaoke night', 'open_mic_karaoke'],
  ),

  activity(
    'community_cleanup',
    'Community Cleanup',
    'Community & Groups',
    'community',
    'community-cleanup.png',
    ['beach cleanup', 'park cleanup', 'community clean up'],
  ),
  activity(
    'garden_club',
    'Garden Club',
    'Community & Groups',
    'wellness',
    'garden-club.png',
    ['gardening club', 'gardening_home'],
  ),
  activity(
    'pet_meetup',
    'Pet Meetup',
    'Community & Groups',
    'community',
    'pet-meetup.png',
    ['dog meetup', 'pet group'],
  ),
  activity(
    'kids_playgroup',
    "Kids' Playgroup",
    'Community & Groups',
    'wellness',
    'kids-playgroup.png',
    ['kids playgroup', 'keiki playgroup', 'parenting_playgroups', 'keiki_family'],
  ),
  activity(
    'language_exchange',
    'Language Exchange',
    'Community & Groups',
    'community',
    'language-exchange.png',
    ['conversation exchange', 'cultural_community'],
  ),
  activity(
    'tech_meetup',
    'Tech Meetup',
    'Community & Groups',
    'art',
    'tech-meetup.png',
    ['technology meetup', 'coding meetup', 'maker_technology'],
  ),
  activity(
    'swap_exchange',
    'Swap & Exchange',
    'Community & Groups',
    'community',
    'swap-exchange.png',
    ['clothing swap', 'clothing exchange', 'clothing collection', 'seed swap', 'community swap',
      'goodwill reuse', 'reuse collection', 'reusable goods'],
  ),
  activity(
    'volunteer_donation',
    'Volunteer Donation',
    'Community & Groups',
    'community',
    'volunteer-donation.png',
    ['volunteer drive', 'donation drive', 'volunteer_service'],
  ),
]);

export const TOPICS = {
  outdoors: {
    label: 'Move & Explore',
    tagline: 'Fresh air. Good company.',
    poster: `${ART}/move-explore.jpg`,
    fields: [wash('#e6f0e8', '#cfe3d6'), wash('#e2efe6', '#d3e6d9')],
    ink: '#303234',
    chip: '#e6f0e8',
    chipInk: '#2f5a51',
    icon: `${ACTIVITY_ICON}/hiking-together.png`,
    motif: 'outdoors',
    match: ['move', 'explore', 'outdoor', 'outdoors', 'hiking', 'hike', 'camping', 'beach', 'running', 'run',
      'fitness', 'sports', 'sport', 'golf', 'watersports', 'stand_up_paddle',
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
    icon: `${ACTIVITY_ICON}/live-music.png`,
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
    icon: `${ACTIVITY_ICON}/reading-book-club.png`,
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
    icon: `${ACTIVITY_ICON}/farmers-market-stall.png`,
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
    icon: `${ACTIVITY_ICON}/pottery.png`,
    motif: 'art',
    match: ['make', 'create', 'art', 'arts_crafts', 'arts_culture', 'visual_art', 'craft', 'crafts',
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
    icon: `${ACTIVITY_ICON}/volunteer-donation.png`,
    motif: 'community',
    match: ['community', 'volunteer', 'service', 'advocacy', 'fundraiser', 'donation',
      'reuse', 'civic', 'veterans', 'lgbtq', 'women', 'youth', 'seniors', 'kupuna',
      'networking', 'business', 'professional', 'leadership', 'conference', 'spirituality'],
  },
  support: {
    label: 'Support Groups',
    category: 'support_group',
    tagline: 'Meet with people who understand.',
    // A privacy-neutral people illustration, never a diagnosis or recovery
    // symbol. The resolver below also blocks title-derived activity art for
    // every protected support listing.
    poster: `${ART}/community-causes.jpg`,
    fields: [wash('#eee8f4', '#ddd3e8'), wash('#f0ebf5', '#e2d9eb')],
    ink: '#303234',
    chip: '#eee8f4',
    chipInk: '#514166',
    icon: `${ACTIVITY_ICON}/language-exchange.png`,
    motif: 'community',
    // Exact-only aliases are handled before word matching below. Keeping the
    // register key in `match` also lets the Index print/file the raw category.
    exact: ['support', 'support_group', 'support group', 'support groups'],
    match: ['support_group'],
    sensitiveParticipation: true,
  },
  wellness: {
    label: 'Family & Wellbeing',
    tagline: 'Care. Connect. Feel at home.',
    poster: `${ART}/plants-home.jpg`,
    fields: [wash('#e8f1ef', '#d5e6e2'), wash('#eaf2f0', '#d9e9e5')],
    ink: '#303234',
    chip: '#e8f1ef',
    chipInk: '#2f5a51',
    icon: `${ACTIVITY_ICON}/kids-playgroup.png`,
    motif: 'wellness',
    match: ['garden', 'gardening', 'plants', 'plant', 'home', 'health', 'health_wellness',
      'community_health', 'healthcare', 'wellness', 'mental_health',
      'sound_bath', 'meditation', 'yoga', 'stretching', 'playgroup', 'early_childhood', 'family',
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
    icon: `${ACTIVITY_ICON}/language-exchange.png`,
    motif: 'night',
    match: ['nights', 'night', 'nightlife', 'night_market', 'games', 'game', 'trivia', 'social',
      'festival', 'holiday', 'party', 'bingo', 'mixer', 'club'],
  },
};

/**
 * Public activity subsections, decorated with the design-family colour of the
 * topic they file into. A consumer never has to maintain an icon or colour map
 * of its own: resolving an activity returns both.
 */
export const ACTIVITIES = Object.freeze(Object.fromEntries(ACTIVITY_DEFINITIONS.map((definition, index) => {
  const topic = TOPICS[definition.topicKey];
  return [definition.key, Object.freeze({
    ...definition,
    fields: topic.fields,
    field: topic.fields[index % topic.fields.length],
    ink: topic.ink,
    chip: topic.chip,
    chipInk: topic.chipInk,
  })];
})));

export const ACTIVITY_KEYS = Object.freeze(Object.keys(ACTIVITIES));

export const ACTIVITY_FAMILIES = Object.freeze(ACTIVITY_KEYS.reduce((families, key) => {
  const item = ACTIVITIES[key];
  return {
    ...families,
    [item.family]: Object.freeze([...(families[item.family] || []), key]),
  };
}, {}));

export const TOPIC_KEYS = Object.keys(TOPICS);

/**
 * Support participation can reveal health or recovery information. It remains
 * browseable as a public directory topic, but is not offered as a profile
 * interest that the people directory publishes to every signed-in user.
 */
export const INTEREST_TOPIC_KEYS = TOPIC_KEYS.filter(key => !TOPICS[key].sensitiveParticipation);

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

const phrase = value => String(value || '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[_-]+/g, ' ')
  .replace(/[^a-z0-9' ]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const ACTIVITY_ALIASES = Object.freeze(ACTIVITY_KEYS.flatMap(key => (
  ACTIVITIES[key].aliases.map(alias => Object.freeze({ key, alias: phrase(alias) }))
)).filter(candidate => candidate.alias).sort((left, right) => right.alias.length - left.alias.length));

const activityMatchForSource = source => {
  const values = [source].flat().filter(Boolean).map(phrase).filter(Boolean);
  if (values.length === 0) return null;

  const exact = ACTIVITY_ALIASES.find(candidate => values.includes(candidate.alias));
  if (exact) return ACTIVITIES[exact.key];

  const text = ` ${values.join(' ')} `;
  const contained = ACTIVITY_ALIASES.find(candidate => text.includes(` ${candidate.alias} `));
  return contained ? ACTIVITIES[contained.key] : null;
};

/** Resolve the most specific supplied activity illustration, if one is named. */
export const activityFor = (...sources) => (
  sources.reduce((found, source) => found || activityMatchForSource(source), null)
);

const preferSpecificActivity = (topic, ...sources) => {
  if (topic.sensitiveParticipation) return topic;
  const specific = activityFor(...sources);
  if (!specific || specific.key === topic.activityKey) return topic;
  return {
    ...topic,
    icon: specific.icon,
    activityKey: specific.key,
    activityLabel: specific.label,
    field: specific.field,
  };
};

export const topicFor = (...sources) => {
  const exactValues = sources
    .flatMap(source => [source].flat())
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase().replace(/\s+/g, ' '));
  const groups = sources.map(source => words([source].flat().filter(Boolean).join(' ')));
  const seed = groups.flat().join(' ');
  const exactHit = TOPIC_KEYS.find(key => (
    (TOPICS[key].exact || []).some(alias => exactValues.includes(alias))
  )) || null;
  const resolvedActivity = activityFor(...sources);
  const hit = exactHit || groups.reduce((found, tokens) => {
    if (found || tokens.length === 0) {
      return found;
    }
    const bag = new Set(tokens);
    return TOPIC_KEYS.find(key => TOPICS[key].match.some(word => bag.has(word))) || null;
  }, null) || resolvedActivity?.topicKey || null;
  const key = hit || FALLBACK_ORDER[stableIndex(seed, FALLBACK_ORDER.length)];
  const topic = TOPICS[key];
  // Protected support listings deliberately keep the neutral topic artwork.
  // Their titles and descriptions may name a diagnosis, recovery pathway, or
  // family circumstance; turning those words into a more specific public icon
  // would undo the privacy boundary even though the icon library itself is not
  // medical artwork.
  const effectiveActivity = topic.sensitiveParticipation ? null : resolvedActivity;
  return {
    key,
    ...topic,
    // Specific art is additive: the reviewed top-level topic still supplies
    // the label and colour, while a named activity supplies the illustration.
    icon: effectiveActivity?.icon || topic.icon,
    activityKey: effectiveActivity?.key || null,
    activityLabel: effectiveActivity?.label || null,
    // Unmatched items still get a varied field, but they must not claim a
    // subject they were never matched on.
    matched: Boolean(hit),
    label: hit ? topic.label : 'Community & Causes',
    // Two verified washes per topic: a directory where one category dominates
    // still reads with rhythm instead of as a wall of one colour.
    field: effectiveActivity?.field || topic.fields[stableIndex(`${seed}~`, topic.fields.length)],
  };
};

/**
 * One resolution per kind, so a record cannot be one topic on its card and
 * another in the filter that surfaced it — or on the sheet that opens from it.
 * Both readings existed side by side before this and disagreed whenever an
 * event carried categories of its own.
 *
 * A reviewed event topic is an editorial decision, so topicIds and categories
 * lead. Title and description remain fallbacks for older records that predate
 * reviewed ingestion. A club is named for who it is, so its categories lead.
 *
 * The host is deliberately not a source. It used to be the fallback for an
 * event named after a person, but every imported event carries categories of
 * its own, and reading the host on some pages and not others gave one event two
 * colours. Both the order and the content of these sources are load-bearing:
 * the first group to match wins, and all of them together seed which of the
 * topic's two washes gets drawn.
 */
export const topicForEvent = event => preferSpecificActivity(
  topicFor(
    normalizeCategories(event.topicIds),
    normalizeCategories(event.categories),
    event.title,
    event.description,
  ),
  event.title,
  event.description,
  normalizeCategories(event.categories),
  normalizeCategories(event.topicIds),
);

export const topicForClub = club => preferSpecificActivity(
  topicFor(
    normalizeCategories(club.categories),
    club.tags,
    club.name,
    club.description,
  ),
  club.name,
  club.description,
  club.tags,
  normalizeCategories(club.categories),
);

/** Icon + colour for one of the user's stated interests. */
export const interestMeta = interest => topicFor(interest);
