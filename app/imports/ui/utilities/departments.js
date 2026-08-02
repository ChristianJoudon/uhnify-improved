import { TOPICS, TOPIC_KEYS, topicFor } from './topics';

/**
 * The Index's departments are the topics.
 *
 * This used to be its own five-bucket taxonomy — Study & Career, Service &
 * Greek, Play & Outdoors — invented for a University-of-Hawaii club directory
 * and left behind when the app moved to Kauaʻi and to the eight categories the
 * covers name. Two vocabularies for one idea meant a group could file under
 * "Play & Outdoors" in the rail while its poster said "Move & Explore".
 *
 * So there is one vocabulary now. A department IS a topic: same label, same
 * tagline, same colour, same matching. Adding a ninth category adds a ninth
 * department for free.
 */
export const DEPARTMENTS = TOPIC_KEYS.map((key, index) => ({
  folio: String(index + 1).padStart(2, '0'),
  key,
  label: TOPICS[key].label,
  /** Colour comes from the topic it is. */
  topic: key,
  note: TOPICS[key].tagline,
  /** The register's own category words that file into this topic. */
  categories: TOPICS[key].match,
}));

export const DEPT_BY_KEY = Object.fromEntries(DEPARTMENTS.map(dept => [dept.key, dept]));

/** Category word -> topic key. */
export const CATEGORY_DEPT = new Map(
  DEPARTMENTS.flatMap(dept => dept.categories.map(category => [category.toLowerCase(), dept.key])),
);

/**
 * How a raw category word is printed. The register writes machine words —
 * `farmers_market`, `health_wellness` — which are fine as data and wrong on a
 * page.
 */
const titleCase = word => word.charAt(0).toUpperCase() + word.slice(1);
export const KIND_LABEL = new Map(
  DEPARTMENTS.flatMap(dept => dept.categories.map(category => [
    category.toLowerCase(),
    titleCase(category.replace(/_/g, ' ')),
  ])),
);

/**
 * File a record. One line now, because the topic system already does this and
 * doing it twice was the whole problem: whatever the poster says, the rail says.
 */
export const departmentsFor = (categories = [], ...rest) => {
  const topic = topicFor(categories, ...rest);
  return topic.matched ? [topic.key] : [];
};
