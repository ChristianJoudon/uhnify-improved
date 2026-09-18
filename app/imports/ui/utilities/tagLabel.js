import { INGESTION_REVIEW_TAXONOMY } from '../../api/ingestion/IngestionReviewTaxonomy';

/**
 * A tag as a person would say it.
 *
 * Listings that came through review carry their category as the review
 * taxonomy's own keys — `music`, `open_mic_karaoke` — because those keys are
 * what the filters and the artwork run on. They are not words: a chip that
 * reads "open_mic_karaoke" is the database showing through. The taxonomy
 * already has the words ("Open mic & karaoke"); anything it does not know —
 * a member's own tag on a group — is shown as typed, with a key's underscores
 * and hyphens read as the spaces they stand for.
 */
const LABELS = new Map(Object.entries(INGESTION_REVIEW_TAXONOMY).flatMap(([topicKey, topic]) => [
  [topicKey, topic.label],
  ...topic.subcategories.map(option => [option.key, option.label]),
]));

export const tagLabel = tag => {
  const text = `${tag ?? ''}`.trim();
  const known = LABELS.get(text) || LABELS.get(text.toLowerCase());
  if (known) return known;
  if (!/[_-]/.test(text) || /\s/.test(text)) return text;
  const spaced = text.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

/** Labels, each once: a tag that says what a category already said is not said twice. */
export const tagLabels = (tags, alreadyShown = []) => {
  const seen = new Set(alreadyShown.map(label => `${label}`.toLowerCase()));
  return tags.map(tagLabel).filter(label => {
    const key = label.toLowerCase();
    if (!label || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
