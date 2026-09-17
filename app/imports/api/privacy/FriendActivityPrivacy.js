import { TOPICS } from '../../ui/utilities/topics';

export const FRIEND_ACTIVITY_VISIBILITY = Object.freeze({
  private: 'private',
  shareable: 'shareable',
});

/**
 * Words that make a listing one a person's friends are never told about:
 * support and recovery, health, LGBTQ+, faith.
 *
 * The test used to be one exact category, 'support_group'. The register also
 * files listings under 'mental_health', 'lgbtq', 'spirituality', 'health' and
 * 'health_wellness' (the memory cafe is one of those), and every one of them
 * was shown to every friend of everyone who joined.
 *
 * It is a list of words rather than of whole categories because a category is
 * not a controlled vocabulary here. The register's are, but a group's come
 * from a free-text chip box exactly as its tags do, so "Recovery meetings" has
 * to be caught as surely as 'addiction_recovery'. Reading both the same way
 * also means a compound needs no entry of its own: 'support_group',
 * 'community_health' and 'mental_health' are caught by the word inside them.
 *
 * It errs toward private, on purpose. A yoga class wrongly kept from friends
 * costs nothing, and nobody will ever notice. A recovery meeting wrongly shown
 * to them cannot be taken back. So the short fellowship names are here too,
 * and on this island 'na' will sometimes hide a Na Pali hiking group; that is
 * the cheap side of the trade.
 *
 * A term is matched as a whole word, so the word next to it needs an entry of
 * its own. The first list had 'spirituality' and not 'spiritual', which is the
 * one people type, 'church' and not 'churches', and nothing for 'rehab', a
 * twelve-step meeting or 'pride'. Each of those was a listing shown.
 */
const SENSITIVE_TERMS = [
  'support', 'recovery', 'addiction', 'rehab', 'sober', 'sobriety', 'aa', 'na', 'al-anon', 'alanon',
  '12 step', '12 steps', 'twelve step', 'twelve steps',
  'grief', 'bereavement',
  'health', 'healthcare', 'mental', 'therapy', 'counseling', 'counselling', 'cancer', 'hiv',
  'lgbt', 'lgbtq', 'lgbtqia', 'queer', 'pride', 'trans', 'transgender', 'gay', 'lesbian', 'bisexual',
  'nonbinary', 'non binary',
  'spiritual', 'spirituality', 'faith', 'religion', 'religious', 'christian', 'catholic',
  'church', 'churches', 'temple', 'bible', 'prayer', 'worship', 'ministry',
];

/**
 * Lower case, every run of anything else turned into one space, and a space at
 * each end — so 'Mental-Health', 'mental_health' and 'mental health' are one
 * string, and a term can be looked for as a whole word. Whole words are the
 * point: a 'national parks' tag must not be read as Narcotics Anonymous.
 */
const spaced = value => ` ${`${value ?? ''}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

const SENSITIVE_PATTERNS = SENSITIVE_TERMS.map(spaced);

const listOf = value => {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
};

const namesSomethingSensitive = value => {
  const text = spaced(value);
  return SENSITIVE_PATTERNS.some(pattern => text.includes(pattern));
};

/**
 * Everything isSensitiveListing reads. A caller that loads listings only to
 * judge them projects to these — a listing can carry a photo inline — and the
 * list lives here so that a signal added below cannot be starved by a
 * projection written somewhere else.
 */
export const LISTING_PRIVACY_FIELDS = Object.freeze({
  categories: 1,
  tags: 1,
  topicIds: 1,
  supportSubtype: 1,
});

/**
 * Whether taking part in this listing says something about a person that is
 * theirs alone to tell. Any one signal is enough: a category or a tag that
 * names something sensitive, a reviewed topic marked sensitiveParticipation,
 * or the support subtype that ingestion attaches to a support listing.
 *
 * A listing that cannot be found is treated as sensitive. Nothing is known
 * about it, and what is not known is not shared.
 */
export const isSensitiveListing = record => {
  if (!record) return true;
  // Read as a list, like the rest: withHostSignals hands over every field as
  // one, and an empty list must not count as a subtype.
  if (listOf(record.supportSubtype).length > 0) return true;
  if (listOf(record.topicIds).some(topicId => TOPICS[`${topicId}`.trim().toLowerCase()]?.sensitiveParticipation)) {
    return true;
  }
  return [...listOf(record.categories), ...listOf(record.tags)].some(namesSomethingSensitive);
};

/**
 * An event as an RSVP to it has to be judged: carrying every signal its hosts
 * carry, beside its own.
 *
 * Going to a group's Thursday meeting says what belonging to the group says,
 * and the event's own record often does not say it. 'Events.insert' copies the
 * host's categories once, when the event is made — never its tags, its topics
 * or its support subtype, and never again after the group is re-filed. So an
 * RSVP judged against the event alone was shown to friends for a group tagged
 * 'sober', and went on being shown after a group was moved under 'lgbtq'.
 *
 * The fields come from LISTING_PRIVACY_FIELDS, so a signal added there is
 * carried across without anyone remembering this function. An event that
 * cannot be found stays missing, and is judged sensitive like any other.
 */
export const withHostSignals = (event, hosts = []) => event && Object.fromEntries(
  Object.keys(LISTING_PRIVACY_FIELDS).map(field => [
    field,
    [event, ...hosts].flatMap(record => listOf(record[field])),
  ]),
);

/**
 * What a membership or an RSVP row says about itself to the friend-activity
 * publication. 'shareable' takes three things at once: the person has turned
 * sharing on, the listing exists, and the listing is not sensitive. Everything
 * else is 'private' — including a caller that forgot to pass the preference,
 * which is how a new call site fails closed instead of open.
 *
 * It used to take the listing alone and answer 'shareable' for nearly all of
 * them, so by default every friend saw every group a person joined and every
 * event they were going to, and there was no setting anywhere to stop it.
 */
export const friendActivityVisibilityFor = (record, options) => (
  options?.sharing === true && record && !isSensitiveListing(record)
    ? FRIEND_ACTIVITY_VISIBILITY.shareable
    : FRIEND_ACTIVITY_VISIBILITY.private
);
