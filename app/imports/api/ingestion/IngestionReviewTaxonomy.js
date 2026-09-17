import {
  ACTIVITIES,
  ACTIVITY_KEYS,
  TOPICS,
  TOPIC_KEYS,
} from '../../ui/utilities/topics';

export const INGESTION_TOPIC_KEYS = Object.freeze([...TOPIC_KEYS]);

const options = (...entries) => entries.map(([key, label]) => Object.freeze({ key, label }));

/**
 * Keep the editorial catch-all choices, then add every supplied activity under
 * its existing MatchBook topic. Existing keys win, so `live_music` and the
 * other established review values retain their stored identity while gaining
 * the corresponding icon automatically through topics.js.
 */
const optionsWithActivities = (topicKey, ...entries) => {
  const indexed = new Map(options(...entries).map(option => [option.key, option]));
  ACTIVITY_KEYS.filter(key => ACTIVITIES[key].topicKey === topicKey).forEach(key => {
    if (!indexed.has(key)) {
      indexed.set(key, Object.freeze({ key, label: ACTIVITIES[key].label }));
    }
  });
  return Object.freeze([...indexed.values()]);
};

/**
 * Review taxonomy for imported community listings.
 *
 * The top-level keys deliberately match MatchBook's existing topics, so an
 * approved suggestion immediately powers today's filters and card styling.
 * Subcategories add useful editorial detail without creating a second public
 * category system or requiring new artwork.
 */
export const INGESTION_REVIEW_TAXONOMY = Object.freeze({
  outdoors: Object.freeze({
    label: TOPICS.outdoors.label,
    subcategories: optionsWithActivities(
      'outdoors',
      ['outdoor_recreation', 'Outdoor recreation'],
      ['fitness_movement', 'Fitness & movement'],
      ['water_sports', 'Water sports'],
      ['nature_environment', 'Nature & environment'],
      ['spectator_sports', 'Sports & games'],
    ),
  }),
  music: Object.freeze({
    label: TOPICS.music.label,
    subcategories: optionsWithActivities(
      'music',
      ['live_music', 'Live music'],
      ['dance_hula', 'Dance & hula'],
      ['theater_comedy', 'Theater & comedy'],
      ['open_mic_karaoke', 'Open mic & karaoke'],
      ['parade_performance', 'Parades & performances'],
    ),
  }),
  books: Object.freeze({
    label: TOPICS.books.label,
    subcategories: optionsWithActivities(
      'books',
      ['classes_workshops', 'Classes & workshops'],
      ['talks_discussions', 'Talks & discussions'],
      ['books_writing', 'Books & writing'],
      ['storytime_literacy', 'Storytime & literacy'],
      ['history_culture', 'History & culture'],
    ),
  }),
  food: Object.freeze({
    label: TOPICS.food.label,
    subcategories: optionsWithActivities(
      'food',
      ['farmers_market', 'Farmers markets'],
      ['local_market', 'Makers & local markets'],
      ['community_meals', 'Community meals'],
      ['food_drink', 'Food & drink'],
      ['cooking', 'Cooking'],
    ),
  }),
  art: Object.freeze({
    label: TOPICS.art.label,
    subcategories: optionsWithActivities(
      'art',
      ['arts_crafts', 'Arts & crafts'],
      ['visual_art_exhibitions', 'Visual art & exhibitions'],
      ['film_photography', 'Film & photography'],
      ['maker_technology', 'Making & technology'],
    ),
  }),
  community: Object.freeze({
    label: TOPICS.community.label,
    subcategories: optionsWithActivities(
      'community',
      ['civic_government', 'Civic & government'],
      ['volunteer_service', 'Volunteer & service'],
      ['business_networking', 'Business & networking'],
      ['faith_spirituality', 'Faith & spirituality'],
      ['family_youth', 'Family & youth'],
      ['senior_services', 'Senior services'],
      ['cultural_community', 'Culture & community'],
    ),
  }),
  support: Object.freeze({
    label: TOPICS.support.label,
    subcategories: optionsWithActivities(
      'support',
      ['addiction_recovery', 'Addiction recovery'],
      ['family_addiction_support', 'Family addiction support'],
      ['mental_health_peer', 'Mental health peer support'],
      ['mental_health_family', 'Mental health family support'],
      ['dementia_caregiver', 'Dementia caregiver support'],
      ['caregiver_support', 'Caregiver support'],
      ['general_support', 'General support'],
    ),
  }),
  wellness: Object.freeze({
    label: TOPICS.wellness.label,
    subcategories: optionsWithActivities(
      'wellness',
      ['yoga_meditation', 'Yoga & meditation'],
      ['health_wellness', 'Health & wellness'],
      ['keiki_family', 'Keiki & family'],
      ['kupuna_aging', 'Kūpuna & aging'],
      ['gardening_home', 'Gardening & home'],
      ['parenting_playgroups', 'Parenting & playgroups'],
    ),
  }),
  night: Object.freeze({
    label: TOPICS.night.label,
    subcategories: optionsWithActivities(
      'night',
      ['festivals_fairs', 'Festivals & fairs'],
      ['nightlife_social', 'Nightlife & social'],
      ['games_trivia', 'Games & trivia'],
      ['holiday_celebration', 'Holiday celebrations'],
    ),
  }),
});

export const subcategoryOptionsFor = topicKey => (
  INGESTION_REVIEW_TAXONOMY[topicKey]?.subcategories || []
);

export const isValidReviewSelection = selection => {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection)) return false;
  const topic = INGESTION_REVIEW_TAXONOMY[selection.topicKey];
  if (!topic) return false;
  return topic.subcategories.some(option => option.key === selection.subcategoryKey);
};

export const reviewSelectionLabels = selection => {
  if (!isValidReviewSelection(selection)) return null;
  const topic = INGESTION_REVIEW_TAXONOMY[selection.topicKey];
  const subcategory = topic.subcategories.find(option => option.key === selection.subcategoryKey);
  return { topic: topic.label, subcategory: subcategory.label };
};
