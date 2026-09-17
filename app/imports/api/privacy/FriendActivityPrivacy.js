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
 * Everything isSensitiveListing, isAnonymousListing and isPrivateListing
 * read. A caller that loads listings only to judge them projects to these — a
 * listing can carry a photo inline — and the list lives here so that a signal
 * added below cannot be starved by a projection written somewhere else.
 *
 * `anonymous` and `visibility` are here for the same reason the rest are:
 * withHostSignals carries every field in this list from a host group to its
 * events, which is how an anonymous group's Thursday meeting is anonymous
 * too, and how an RSVP to a private group's meeting is kept from friends.
 */
export const LISTING_PRIVACY_FIELDS = Object.freeze({
  categories: 1,
  tags: 1,
  topicIds: 1,
  supportSubtype: 1,
  anonymous: 1,
  visibility: 1,
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
 * Whether nobody at all may be shown who takes part in this listing — not
 * other members, not friends, not the person who runs it. Counts only.
 *
 * Two ways to be one. Its owner said so (`anonymous`), or it is sensitive, in
 * which case nobody was asked: a recovery meeting whose organizer forgot a
 * checkbox is still a recovery meeting, so that half cannot be switched off.
 *
 * Every reader of "who is in this" asks HERE and never reads the `anonymous`
 * field alone, for two reasons. The field knows nothing about sensitivity.
 * And for an event the answer also rests on its host groups: hand over the
 * event as withHostSignals returns it and a host's flag counts as the event's
 * own. That shape holds each field as a list, which is why the flag is read
 * as one; only a real `true` counts, so a stray string is not consent to
 * anything. A listing that cannot be found is anonymous, as it is sensitive.
 */
export const isAnonymousListing = record => (
  listOf(record?.anonymous).some(flag => flag === true) || isSensitiveListing(record)
);

/**
 * Whether this listing is kept from people who were not let into it.
 *
 * Read the way the publications read it (see PUBLIC_LISTING_SELECTOR in
 * listing/audience.js): absent or 'public' is public, and ANY other value is
 * private — 'members', 'unlisted', or a word added next year — so a value
 * nobody here has heard of hides a listing rather than showing it.
 *
 * Like the anonymous flag it is read as a list, because an event is judged as
 * withHostSignals hands it over: one private host is enough. An RSVP to a
 * private group's meeting says the person is in the group, however public the
 * meeting itself was made. A listing that cannot be found is private.
 *
 * Only `undefined` is "never given one". listOf would drop a null or an empty
 * string along with it, and the publications send neither of those to the
 * public, so they are not public here.
 */
export const isPrivateListing = record => !record
  || (Array.isArray(record.visibility) ? record.visibility : [record.visibility])
    .some(value => value !== undefined && value !== 'public');

/**
 * What a membership or an RSVP row says about itself to the friend-activity
 * publication. 'shareable' takes four things at once: the person has turned
 * sharing on, the listing exists, it is not anonymous — which every sensitive
 * listing is — and it is not private. Everything else is 'private' —
 * including a caller that forgot to pass the preference, which is how a new
 * call site fails closed instead of open.
 *
 * It used to take the listing alone and answer 'shareable' for nearly all of
 * them, so by default every friend saw every group a person joined and every
 * event they were going to, and there was no setting anywhere to stop it.
 *
 * Anonymity is judged here rather than beside it because a friend is somebody:
 * a group that shows its own organizer no names cannot go on showing them to
 * each member's friends.
 *
 * Private was the one left out, and it is judged here for the same reason. A
 * shared row is sent to friends whole — who, and the _id of what — so a
 * sharing member of a private group told every friend that the group exists,
 * that they are in it, and the id every method about it is called with. The
 * public link rows are withheld for a private listing to keep exactly that
 * from getting out; this was the way round them.
 */
export const friendActivityVisibilityFor = (record, options) => (
  options?.sharing === true && record && !isAnonymousListing(record) && !isPrivateListing(record)
    ? FRIEND_ACTIVITY_VISIBILITY.shareable
    : FRIEND_ACTIVITY_VISIBILITY.private
);

/**
 * Whether a membership or an RSVP was made under a promise that nobody would
 * ever see it.
 *
 * Anonymity can be switched off, and a listing keeps the moment it last ended
 * (`anonymousUntil`). 'clubs.members' read it from the start, so the person
 * who runs a group is never handed the people who joined because there was no
 * list. The rows friends are sent did not: each was judged against the group
 * as it is NOW, so switching anonymity off put every sharing member back in
 * their friends' feeds, by name, beside the group's id — and the person who
 * runs the group can be one of those friends, which walked straight round the
 * list that would not name them.
 *
 * So the rule is the member list's, word for word: only a row dated AFTER the
 * anonymity ended may be shown, and a row with no date cannot show that it
 * came after. It reaches back past the day the anonymity began, on purpose.
 * Whoever was already in a group when it became a recovery group was in a
 * recovery group, and the one date that is kept cannot tell them from the
 * people who joined the day after.
 *
 * An event is judged as the sync hands it over, carrying the latest such
 * moment among itself and the groups that host it: going to an anonymous
 * group's meeting was covered by the group's promise too.
 */
export const tookPartWhileAnonymous = (record, row) => Boolean(record?.anonymousUntil)
  && !(row?.createdAt > record.anonymousUntil);

/**
 * friendActivityVisibilityFor, for a row that already stands: at a sync, at a
 * second "Join", at a second "Going". There the listing as it is now is only
 * half the question, and the other half is when the row was made.
 */
export const friendActivityVisibilityOfRow = (record, row, options) => (
  tookPartWhileAnonymous(record, row)
    ? FRIEND_ACTIVITY_VISIBILITY.private
    : friendActivityVisibilityFor(record, options)
);
