import crypto from 'crypto';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { Roles } from 'meteor/alanning:roles';
import moment from 'moment-timezone';
import { Clubs } from '../../api/club/Club';
import { Events } from '../../api/events/Events';
import { EventClubs } from '../../api/events/EventClubs';
import { Counters } from '../../api/counters/Counters';
import { syncFriendActivityForClub, syncFriendActivityForEvent } from '../../api/privacy/friendActivitySync';
import {
  CommunitySources,
  IngestionCandidates,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_TOPIC_KEYS,
  isValidReviewSelection,
} from '../../api/ingestion/IngestionReviewTaxonomy';
import {
  ReviewItems,
  SourceEntityKeys,
  SourceObservations,
  SourcePolicyAssessments,
} from '../../api/ingestion/server/IngestionPersistence';

/* eslint-disable no-console */

export const INGESTION_REVIEW_METHODS = Object.freeze({
  approve: 'ingestion.candidates.approve',
  approveAll: 'ingestion.candidates.approveAll',
  approveSeries: 'ingestion.candidates.approveSeries',
  clear: 'ingestion.candidates.clear',
  preview: 'ingestion.candidates.preview',
  reopen: 'ingestion.candidates.reopen',
  saveEditorialOverrides: 'ingestion.candidates.saveEditorialOverrides',
});

const PROJECTION_VERSION = 'community-public.v1';
const IMPORTED_FROM = 'MatchBook community intake';
const SYSTEM_ACTOR = 'MatchBook community intake';
const SOURCE_MANAGED_LINK_ACTOR = SYSTEM_ACTOR;
const MAX_BATCH = 500;
const MAX_BATCH_PROJECTED_RECORDS = 1000;
const MAX_SERIES_BATCH = 100;
const MAX_PREVIEW_BATCH = 500;
const MAX_DISPOSITION_BATCH = 5000;
const DEFAULT_RECURRENCE_SAMPLE = 6;
const MAX_PROJECTED_OCCURRENCES = 64;
const MAX_DUPLICATE_SLOT_LOCKS = MAX_PROJECTED_OCCURRENCES * 4;
const HAWAII_TIME_ZONE = 'Pacific/Honolulu';
const CLAIM_TTL_MS = 5 * 60 * 1000;
const CLASSIFICATION_TAXONOMY_VERSION = 'matchbook-topics.v1';
const DUPLICATE_REVIEW_TITLE = 0.66;
const DUPLICATE_REVIEW_LOCATION = 0.6;
const DUPLICATE_REVIEW_MINUTES = 120;
const DUPLICATE_BLOCK_TITLE = 0.9;
const DUPLICATE_BLOCK_LOCATION = 0.82;
const DUPLICATE_BLOCK_MINUTES = 60;
const GROUP_DUPLICATE_REVIEW_NAME = 0.58;
const GROUP_DUPLICATE_REVIEW_LOCATION = 0.6;
const GROUP_DUPLICATE_REVIEW_SCHEDULE = 0.72;
const GROUP_DUPLICATE_BLOCK_NAME = 0.88;
const GROUP_DUPLICATE_BLOCK_LOCATION = 0.82;
const GROUP_DUPLICATE_BLOCK_SCHEDULE = 0.9;
const MAX_DUPLICATE_MATCHES = 5;
const CLEAR_REASONS = new Set(['REVIEWED_SKIP', 'OUTSIDE_REVIEW_WINDOW']);

const DAY_INDEX = Object.freeze({
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
});

const SUBTYPE_DESCRIPTIONS = Object.freeze({
  addiction_recovery: 'A recurring addiction recovery support group.',
  family_addiction_support: 'A recurring support group for families affected by addiction.',
  mental_health_peer: 'A recurring peer mental health support group.',
  mental_health_family: 'A recurring mental health support group for families.',
  dementia_caregiver: 'A recurring support group for dementia caregivers.',
});

const SUPPORT_SUBCATEGORIES = Object.freeze({
  addiction_recovery: 'addiction_recovery',
  family_addiction_support: 'family_addiction_support',
  mental_health_peer: 'mental_health_peer',
  mental_health_family: 'mental_health_family',
  dementia_caregiver: 'dementia_caregiver',
});

// These are inference rules only. The authoritative keys and valid
// topic/subcategory pairs live in IngestionReviewTaxonomy.
const CLASSIFICATION_RULES = Object.freeze([
  ['food', 'community_meals', /\bcongregate meal|meal service|community meal|senior meal\b/i],
  ['wellness', 'keiki_family', /\bkeiki|youth|children|kids|family program\b/i],
  ['wellness', 'kupuna_aging', /\bkupuna|elder|older adult|senior(?:s| services?)?\b/i],
  ['food', 'farmers_market', /\bfarm(?:er'?s?)?\s+market\b|\bproduce market\b/i],
  ['food', 'local_market', /\b(?:craft|night|local|community)\s+(?:fair|market)\b/i],
  ['food', 'food_drink', /\bfood|dinner|lunch|brunch|coffee|beer|tasting\b/i],
  ['food', 'cooking', /\bcook(?:ing)?|culinary|recipe\b/i],
  ['music', 'live_music', /\bconcert|live music|band|musician|ukulele\b/i],
  ['music', 'dance_hula', /\bhula|luau|dance|dancing\b/i],
  ['music', 'theater_comedy', /\btheat(?:er|re)|comedy|play\b/i],
  ['music', 'open_mic_karaoke', /\bopen mic|karaoke\b/i],
  ['music', 'parade_performance', /\bparade|performance|performing\b/i],
  ['outdoors', 'water_sports', /\bsurf|paddl|canoe|kayak|swim|water sport\b/i],
  ['outdoors', 'fitness_movement', /\bfitness|run(?:ning)?|walk|exercise|movement\b/i],
  ['outdoors', 'nature_environment', /\bnature|environment|conservation|cleanup|garden trail\b/i],
  ['outdoors', 'spectator_sports', /\bsport|game|tournament|league\b/i],
  ['outdoors', 'outdoor_recreation', /\bhik|outdoor|beach|camp|trail\b/i],
  ['art', 'visual_art_exhibitions', /\bexhibit|gallery|visual art|painting|sculpture\b/i],
  ['art', 'film_photography', /\bfilm|movie|cinema|photograph\b/i],
  ['art', 'maker_technology', /\bmaker|robot|technology|coding|lego|design\b/i],
  ['art', 'arts_crafts', /\bart|craft|quilting|printmaking|creative\b/i],
  ['books', 'books_writing', /\bbook|reading|writing|poetry|author\b/i],
  ['books', 'storytime_literacy', /\bstory\s*time|literacy\b/i],
  ['books', 'history_culture', /\bhistory|heritage|culture\b/i],
  ['books', 'talks_discussions', /\btalk|lecture|discussion|speaker\b/i],
  ['books', 'classes_workshops', /\bclass|lesson|workshop|learn|education\b/i],
  ['wellness', 'yoga_meditation', /\byoga|meditat|sound bath\b/i],
  ['wellness', 'health_wellness', /\bhealth|wellness|wellbeing\b/i],
  ['wellness', 'gardening_home', /\bgarden|plant|home\b/i],
  ['wellness', 'parenting_playgroups', /\bparent|playgroup|toddler|baby\b/i],
  ['night', 'games_trivia', /\btrivia|bingo|board game|game night\b/i],
  ['night', 'holiday_celebration', /\bholiday|celebration|christmas|halloween\b/i],
  ['night', 'festivals_fairs', /\bfestival|fair\b/i],
  ['night', 'nightlife_social', /\bnightlife|party|social|mixer|night out\b/i],
  ['community', 'volunteer_service', /\bvolunteer|service project|donation|fundrais|cleanup\b/i],
  ['community', 'civic_government', /\bcivic|government|council|public hearing|board meeting\b/i],
  ['community', 'business_networking', /\bbusiness|networking|professional|chamber\b/i],
  ['community', 'faith_spirituality', /\bfaith|spiritual|church|temple|worship\b/i],
  ['community', 'family_youth', /\bfamily|youth|children|kids|teen\b/i],
  ['community', 'senior_services', /\bsenior|kupuna|older adult\b/i],
  ['community', 'cultural_community', /\bcommunity|cultural|neighborhood|gathering\b/i],
]);

const BLOCKED_CODES = new Set([
  'ingestion-permission-evidence-required',
  'ingestion-policy-not-approved',
  'ingestion-probe-only',
  'ingestion-projection-not-implemented',
  'ingestion-not-publishable',
  'ingestion-candidate-superseded',
  'ingestion-source-item-projection-in-progress',
  'ingestion-duplicate-slot-in-progress',
  'ingestion-duplicate-slot-limit',
  'ingestion-event-outside-promotion-window',
  'ingestion-duplicate-event',
  'ingestion-duplicate-review-required',
  'ingestion-recurring-duplicate-review-required',
  'ingestion-sensitive-review-required',
  'ingestion-classification-review-required',
  'ingestion-editorial-individual-review-required',
  'ingestion-editorial-preview-required',
  'ingestion-effective-validation-required',
  'ingestion-effective-validation-mismatch',
  'ingestion-missing-required-field',
  'ingestion-missing-date',
  'ingestion-invalid-date',
  'ingestion-event-duration-review-required',
  'ingestion-unsupported-time-zone',
  'ingestion-unsupported-recurrence',
  'ingestion-public-field-contact-blocked',
]);

const SENSITIVE_FORBIDDEN_KEY = /(attendee|participant|memberlist|personalcontact|phone|email|zoom|passcode|password|meetingid|healthstatus|diagnosis)/i;
// Kept identical to the pre-storage sensitive scan so approval cannot widen it.
// eslint-disable-next-line max-len
const SENSITIVE_FORBIDDEN_VALUE = /(zoom\.us|\bpasscode\b|\bmeeting\s+id\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\D)(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}(?:\D|$)|(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s]*)?)/i;

const hash = value => crypto.createHash('sha256').update(`${value}`).digest('hex');
const EDITORIAL_PREVIEW_SECRET = crypto.randomBytes(32);
const canonicalMongoId = sourceId => `ci${hash(sourceId).slice(0, 30)}`;
const sourceKeyHash = sourceItemKey => hash(sourceItemKey);

const asText = (value, max = 500) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().replace(/\s+/g, ' ');
  return text ? text.slice(0, max) : undefined;
};

const asStringList = (value, maxItems = 100, maxLength = 300) => (
  Array.isArray(value)
    ? value.map(item => asText(item, maxLength)).filter(Boolean).slice(0, maxItems)
    : []
);

const unique = values => [...new Set(values)];
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const editorialRevisionFor = candidate => (
  Number.isInteger(candidate?.editorialRevision) && candidate.editorialRevision >= 0
    ? candidate.editorialRevision
    : 0
);

const editorialEditTokenFor = candidate => (
  asText(candidate?.editorialEditToken, 200)
  || `initial:${hash([
    candidate?._id,
    candidate?.fingerprint,
    editorialRevisionFor(candidate),
  ].join('|')).slice(0, 40)}`
);

const sanitizedEditorialOverrides = candidate => {
  const stored = candidate?.editorialOverrides;
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
  const result = {};
  const safeText = (value, max) => {
    const text = asText(value, max);
    return text && !SENSITIVE_FORBIDDEN_VALUE.test(text) ? text : undefined;
  };
  const title = safeText(stored.title, 200);
  const location = safeText(stored.location, 300);
  if (title) result.title = title;
  if (location) result.location = location;
  const schedule = stored.schedule;
  if (schedule?.kind === 'ONE_TIME') {
    const localStart = safeText(schedule.localStart, 100);
    const localEnd = safeText(schedule.localEnd, 100);
    if (localStart) {
      result.schedule = {
        kind: 'ONE_TIME',
        localStart,
        ...(localEnd ? { localEnd } : {}),
      };
    }
  } else if (schedule?.kind === 'RECURRENCE') {
    const recurrenceLabel = safeText(schedule.recurrenceLabel, 200);
    if (recurrenceLabel) result.schedule = { kind: 'RECURRENCE', recurrenceLabel };
  }
  return result;
};

const effectiveNormalizedFields = candidate => {
  const fields = { ...(candidate?.normalizedFields || {}) };
  const overrides = sanitizedEditorialOverrides(candidate);
  if (overrides.title) fields.title = overrides.title;
  if (overrides.location) {
    fields.location = overrides.location;
    // Group projection reads the label arrays first. Replacing them only in
    // this derived view makes the edit effective without touching worker data.
    fields.locationLabels = [overrides.location];
  }
  if (overrides.schedule?.kind === 'ONE_TIME') {
    fields.localStart = overrides.schedule.localStart;
    if (overrides.schedule.localEnd) fields.localEnd = overrides.schedule.localEnd;
    else delete fields.localEnd;
    delete fields.recurrenceLabel;
    fields.recurrenceLabels = [];
  } else if (overrides.schedule?.kind === 'RECURRENCE') {
    fields.recurrenceLabel = overrides.schedule.recurrenceLabel;
    fields.recurrenceLabels = [overrides.schedule.recurrenceLabel];
    delete fields.localStart;
    delete fields.localEnd;
  }
  return fields;
};

const stableValue = value => {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => (
    value[key] === undefined ? result : { ...result, [key]: stableValue(value[key]) }
  ), {});
};

const effectiveFieldsHashFor = candidate => hash(
  JSON.stringify(stableValue({
    normalizedFields: effectiveNormalizedFields(candidate),
    sourceValidationState: candidate?.validationState,
    entityHint: candidate?.entityHint
      || (`${candidate?.sourceItemKey}`.startsWith('group:') ? 'group' : undefined)
      || (`${candidate?.sourceItemKey}`.startsWith('event:') ? 'event' : undefined),
  })),
);

const editorialBindingFor = candidate => ({
  editorialRevision: editorialRevisionFor(candidate),
  effectiveFieldsHash: effectiveFieldsHashFor(candidate),
});

const sameEditorialBinding = (left, right) => (
  left?.editorialRevision === right?.editorialRevision
  && left?.effectiveFieldsHash === right?.effectiveFieldsHash
);

const editorialPreviewTokenFor = candidate => {
  const binding = editorialBindingFor(candidate);
  return crypto.createHmac('sha256', EDITORIAL_PREVIEW_SECRET).update([
    candidate?._id,
    candidate?.fingerprint,
    editorialEditTokenFor(candidate),
    binding.editorialRevision,
    binding.effectiveFieldsHash,
  ].join('|')).digest('hex');
};

const publicEditorialState = candidate => ({
  editorialOverrides: sanitizedEditorialOverrides(candidate),
  editorialRevision: editorialRevisionFor(candidate),
  editorialEditToken: editorialEditTokenFor(candidate),
  ...(candidate?.editorialUpdatedAt instanceof Date
    ? { editorialUpdatedAt: candidate.editorialUpdatedAt }
    : {}),
});

const previewEditorialState = candidate => ({
  ...publicEditorialState(candidate),
  ...(editorialRevisionFor(candidate) > 0 ? {
    editorialPreviewToken: editorialPreviewTokenFor(candidate),
  } : {}),
});

const decisionIdFor = (candidateId, binding = { editorialRevision: 0 }) => (
  binding.editorialRevision > 0
    ? `approval:${candidateId}:editorial:${binding.editorialRevision}:${binding.effectiveFieldsHash.slice(0, 16)}`
    : `approval:${candidateId}`
);

const approvalDecisionIdFor = (candidate, binding = editorialBindingFor(candidate)) => (
  asText(candidate?.approvalDecisionId, 300) || decisionIdFor(candidate._id, binding)
);

const assertDurableEditorialBinding = (candidate, decision, binding) => {
  const candidateBinding = {
    editorialRevision: candidate.approvalEditorialRevision,
    effectiveFieldsHash: candidate.approvalEffectiveFieldsHash,
  };
  const decisionBinding = {
    editorialRevision: decision?.editorialRevision,
    effectiveFieldsHash: decision?.effectiveFieldsHash,
  };
  const candidateHasBinding = Number.isInteger(candidateBinding.editorialRevision)
    && typeof candidateBinding.effectiveFieldsHash === 'string';
  const decisionHasBinding = Number.isInteger(decisionBinding.editorialRevision)
    && typeof decisionBinding.effectiveFieldsHash === 'string';
  if ((candidateHasBinding && !sameEditorialBinding(candidateBinding, binding))
      || (decisionHasBinding && !sameEditorialBinding(decisionBinding, binding))
      || (binding.editorialRevision > 0 && (!candidateHasBinding || !decisionHasBinding))) {
    throw new Meteor.Error(
      'ingestion-editorial-binding-mismatch',
      'The approved publication no longer matches its reviewed editorial revision.',
    );
  }
};

const strictEditorialText = (value, field, max) => {
  if (typeof value !== 'string') {
    throw new Meteor.Error(
      'ingestion-invalid-editorial-overrides',
      `The editorial ${field} must be text or null.`,
    );
  }
  const normalized = value.trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > max) {
    throw new Meteor.Error(
      'ingestion-invalid-editorial-overrides',
      `The editorial ${field} is empty or too long.`,
    );
  }
  if (SENSITIVE_FORBIDDEN_VALUE.test(normalized)) {
    throw new Meteor.Error(
      'ingestion-public-field-contact-blocked',
      `The editorial ${field} contains contact, access, or web details that cannot be published.`,
    );
  }
  return normalized;
};

const normalizeEditorialPatch = requested => {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new Meteor.Error(
      'ingestion-invalid-editorial-overrides',
      'Editorial overrides must be an object.',
    );
  }
  const allowed = new Set(['title', 'location', 'schedule']);
  const keys = Object.keys(requested);
  if (!keys.length || keys.some(key => !allowed.has(key))) {
    throw new Meteor.Error(
      'ingestion-invalid-editorial-overrides',
      'Choose at least one supported editorial field.',
    );
  }
  const patch = {};
  if (hasOwn(requested, 'title')) {
    patch.title = requested.title === null
      ? null
      : strictEditorialText(requested.title, 'title', 200);
  }
  if (hasOwn(requested, 'location')) {
    patch.location = requested.location === null
      ? null
      : strictEditorialText(requested.location, 'location', 300);
  }
  if (hasOwn(requested, 'schedule')) {
    if (requested.schedule === null) {
      patch.schedule = null;
    } else {
      const schedule = requested.schedule;
      if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
        throw new Meteor.Error(
          'ingestion-invalid-editorial-overrides',
          'The editorial schedule is invalid.',
        );
      }
      if (schedule.kind === 'ONE_TIME') {
        const scheduleKeys = Object.keys(schedule);
        if (scheduleKeys.some(key => !['kind', 'localStart', 'localEnd'].includes(key))
            || !hasOwn(schedule, 'localStart')) {
          throw new Meteor.Error(
            'ingestion-invalid-editorial-overrides',
            'A one-time schedule needs only a start and optional end.',
          );
        }
        patch.schedule = {
          kind: 'ONE_TIME',
          localStart: strictEditorialText(schedule.localStart, 'start', 100),
          ...(schedule.localEnd === null || schedule.localEnd === undefined ? {} : {
            localEnd: strictEditorialText(schedule.localEnd, 'end', 100),
          }),
        };
      } else if (schedule.kind === 'RECURRENCE') {
        if (Object.keys(schedule).some(key => !['kind', 'recurrenceLabel'].includes(key))
            || !hasOwn(schedule, 'recurrenceLabel')) {
          throw new Meteor.Error(
            'ingestion-invalid-editorial-overrides',
            'A recurring schedule needs only its recurrence label.',
          );
        }
        patch.schedule = {
          kind: 'RECURRENCE',
          recurrenceLabel: strictEditorialText(
            schedule.recurrenceLabel,
            'recurrence',
            200,
          ),
        };
      } else {
        throw new Meteor.Error(
          'ingestion-invalid-editorial-overrides',
          'Choose either a one-time or recurring schedule.',
        );
      }
    }
  }
  return patch;
};

const applyEditorialPatch = (candidate, patch) => {
  const next = sanitizedEditorialOverrides(candidate);
  ['title', 'location', 'schedule'].forEach(field => {
    if (!hasOwn(patch, field)) return;
    if (patch[field] === null) delete next[field];
    else next[field] = patch[field];
  });
  return next;
};

export const communityIngestionSandboxEnabled = () => (
  Meteor.settings.public?.communityIngestionSandbox === true
  && (Meteor.isDevelopment || Meteor.isTest)
);

const normalizeReviewOptions = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The review classification selection is invalid.',
    );
  }
  const allowedKeys = new Set([
    'topicKey',
    'subcategoryKey',
    'duplicateOverride',
    'duplicateReviewAcknowledged',
    'confirmAutomaticClassifications',
    'editorialPreviewToken',
  ]);
  if (Object.keys(options).some(key => !allowedKeys.has(key))) {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The review classification selection contains an unsupported field.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'duplicateOverride')
      && typeof options.duplicateOverride !== 'boolean') {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The duplicate override must be a boolean.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'duplicateReviewAcknowledged')
      && typeof options.duplicateReviewAcknowledged !== 'boolean') {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The duplicate-review acknowledgment must be a boolean.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'confirmAutomaticClassifications')
      && typeof options.confirmAutomaticClassifications !== 'boolean') {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The automatic-classification confirmation must be a boolean.',
    );
  }
  if (Object.prototype.hasOwnProperty.call(options, 'editorialPreviewToken')
      && (typeof options.editorialPreviewToken !== 'string'
        || !/^[a-f0-9]{64}$/.test(options.editorialPreviewToken))) {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'The editorial preview token is invalid.',
    );
  }

  const hasTopic = Object.prototype.hasOwnProperty.call(options, 'topicKey');
  const hasSubcategory = Object.prototype.hasOwnProperty.call(options, 'subcategoryKey');
  if (hasTopic !== hasSubcategory
      || (hasTopic && !isValidReviewSelection({
        topicKey: options.topicKey,
        subcategoryKey: options.subcategoryKey,
      }))) {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'Choose a valid MatchBook topic and subcategory pair.',
    );
  }
  if (options.duplicateOverride === true && !communityIngestionSandboxEnabled()) {
    throw new Meteor.Error(
      'ingestion-duplicate-override-not-allowed',
      'Duplicate overrides are available only in the local ingestion sandbox.',
    );
  }

  return {
    ...(hasTopic ? {
      selection: {
        topicKey: options.topicKey,
        subcategoryKey: options.subcategoryKey,
      },
    } : {}),
    duplicateOverride: options.duplicateOverride === true,
    duplicateReviewAcknowledged: options.duplicateReviewAcknowledged === true,
    confirmAutomaticClassifications: options.confirmAutomaticClassifications === true,
    ...(options.editorialPreviewToken ? {
      editorialPreviewToken: options.editorialPreviewToken,
    } : {}),
  };
};

const finiteConfidence = value => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? Math.round(value * 100) / 100
    : undefined
);

const validClassification = value => Boolean(
  value
  && value.taxonomyVersion === CLASSIFICATION_TAXONOMY_VERSION
  && INGESTION_TOPIC_KEYS.includes(value.topicKey)
  && isValidReviewSelection({
    topicKey: value.topicKey,
    subcategoryKey: value.subcategoryKey,
  }),
);

const isSensitiveSupportCandidate = candidate => (
  `${candidate.sourceId}`.startsWith('SEN-')
  && candidate.normalizedFields?.listingType === 'support_group'
);

const inferredClassification = candidate => {
  const fields = effectiveNormalizedFields(candidate);
  if (isSensitiveSupportCandidate(candidate)) {
    const subcategoryKey = SUPPORT_SUBCATEGORIES[fields.supportSubtype] || 'general_support';
    return {
      topicKey: 'support', subcategoryKey, confidence: 1, basis: 'PROTECTED_SUPPORT_FIELDS',
    };
  }

  // Descriptions are deliberately excluded. Core feeds commonly place email,
  // social, or vendor boilerplate there, and that untrusted prose should
  // neither be published nor silently drive a human review classification.
  const searchable = [fields.title, ...asStringList(fields.categories, 20, 100)]
    .filter(Boolean).join(' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, ' ');
  const match = CLASSIFICATION_RULES.find(([, , pattern]) => pattern.test(searchable));
  if (match && isValidReviewSelection({ topicKey: match[0], subcategoryKey: match[1] })) {
    return {
      topicKey: match[0], subcategoryKey: match[1], confidence: 0.72, basis: 'SERVER_FALLBACK',
    };
  }
  return {
    topicKey: 'community',
    subcategoryKey: 'cultural_community',
    confidence: 0.35,
    basis: 'SERVER_FALLBACK',
  };
};

const effectiveClassification = (candidate, reviewOptions = {}) => {
  if (reviewOptions.selection) {
    return { ...reviewOptions.selection, confidence: 1, basis: 'ADMIN_SELECTION' };
  }
  if (isSensitiveSupportCandidate(candidate)) return inferredClassification(candidate);
  // A title correction invalidates a title/source suggestion until the editor
  // explicitly confirms a category during approval.
  if (!sanitizedEditorialOverrides(candidate).title
      && validClassification(candidate.classificationSuggestion)) {
    return {
      topicKey: candidate.classificationSuggestion.topicKey,
      subcategoryKey: candidate.classificationSuggestion.subcategoryKey,
      basis: 'WORKER_SUGGESTION',
      ...(finiteConfidence(candidate.classificationSuggestion.confidence) !== undefined ? {
        confidence: finiteConfidence(candidate.classificationSuggestion.confidence),
      } : {}),
    };
  }
  return inferredClassification(candidate);
};

const hasBulkSafeSuggestion = candidate => {
  if (editorialRevisionFor(candidate) > 0) return false;
  if (isSensitiveSupportCandidate(candidate)) return true;
  const suggestion = candidate.classificationSuggestion;
  return validClassification(suggestion)
    && finiteConfidence(suggestion.confidence) >= 0.95
    && Array.isArray(suggestion.reasons)
    && suggestion.reasons.includes('SOURCE_CATEGORY_MATCH')
    && !suggestion.reasons.includes('FALLBACK_COMMUNITY');
};

const assertClassificationAllowed = (
  candidate,
  classification,
) => {
  if (isSensitiveSupportCandidate(candidate) && classification.topicKey !== 'support') {
    throw new Meteor.Error(
      'ingestion-invalid-review-selection',
      'Sensitive support listings must remain in the Support Groups topic.',
    );
  }
  if (!isSensitiveSupportCandidate(candidate) && classification.topicKey === 'support') {
    throw new Meteor.Error(
      'ingestion-sensitive-review-required',
      'Support listings must use the protected sensitive-review intake lane.',
    );
  }
  const unconfirmedFallback = classification.basis === 'SERVER_FALLBACK';
  const untrustedSuggestion = classification.basis === 'WORKER_SUGGESTION'
    && !hasBulkSafeSuggestion(candidate);
  if (!isSensitiveSupportCandidate(candidate)
      && (unconfirmedFallback || untrustedSuggestion)) {
    throw new Meteor.Error(
      'ingestion-classification-review-required',
      'Confirm a topic and subcategory before publishing this legacy candidate.',
    );
  }
};

const assertPublicEventText = (value, field) => {
  if (SENSITIVE_FORBIDDEN_VALUE.test(value)) {
    throw new Meteor.Error(
      'ingestion-public-field-contact-blocked',
      `The event ${field} contains contact, access, or web details that cannot be published.`,
    );
  }
};

const requireAdmin = userId => {
  if (!userId) {
    throw new Meteor.Error('not-logged-in', 'You must be signed in to review intake candidates.');
  }
  if (!Roles.userIsInRole(userId, 'admin')) {
    throw new Meteor.Error('not-authorized', 'You must be an administrator to review intake candidates.');
  }
};

const publicSourceUrl = (candidate, observation, source) => {
  const candidateUrl = asText(candidate.normalizedFields?.sourceUrl, 1000);
  const observedUrl = asText(observation.canonicalSourceUrl, 1000);
  const publisherUrl = asText(source.publisherUrl, 1000);
  const sensitive = `${candidate.sourceId}`.startsWith('SEN-');
  const proposed = sensitive
    ? (candidateUrl || observedUrl || publisherUrl)
    : (candidateUrl || publisherUrl);
  let selected = proposed;
  if (!selected) return undefined;

  let parsed;
  let publisher;
  try {
    parsed = new URL(selected);
    publisher = publisherUrl ? new URL(publisherUrl) : null;
  } catch (error) {
    throw new Meteor.Error('ingestion-invalid-source-url', 'The candidate source URL is invalid.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Meteor.Error('ingestion-invalid-source-url', 'The candidate source URL must be a public HTTPS URL.');
  }

  if (sensitive) {
    if (!publisherUrl || selected !== publisherUrl || observedUrl !== publisherUrl) {
      throw new Meteor.Error(
        'ingestion-sensitive-source-mismatch',
        'Sensitive support listings may link only to their approved public source page.',
      );
    }
  } else {
    if (!publisher || publisher.protocol !== 'https:' || publisher.username || publisher.password) {
      throw new Meteor.Error(
        'ingestion-invalid-source-url',
        'The source publisher URL must be a public HTTPS URL.',
      );
    }
    const proposedHost = parsed.hostname.replace(/^www\./, '');
    const publisherHost = publisher.hostname.replace(/^www\./, '');
    if (proposedHost !== publisherHost) {
      parsed = publisher;
      selected = publisherUrl;
    }
  }
  if (sensitive) return selected;
  return parsed.toString();
};

const assertSensitivePayload = (value, allowedSourceUrl, path = 'normalizedFields') => {
  if (typeof value === 'string') {
    const approvedSource = path.endsWith('.sourceUrl') && value === allowedSourceUrl;
    if (!approvedSource && SENSITIVE_FORBIDDEN_VALUE.test(value)) {
      throw new Meteor.Error(
        'ingestion-sensitive-data-blocked',
        `Sensitive access or contact data was blocked at ${path}.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertSensitivePayload(entry, allowedSourceUrl, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  Object.entries(value).forEach(([key, entry]) => {
    if (SENSITIVE_FORBIDDEN_KEY.test(key.replace(/_/g, ''))) {
      throw new Meteor.Error(
        'ingestion-sensitive-data-blocked',
        `A prohibited sensitive field was blocked at ${path}.${key}.`,
      );
    }
    assertSensitivePayload(entry, allowedSourceUrl, `${path}.${key}`);
  });
};

const latestSourcePolicy = sourceId => SourcePolicyAssessments.findOne(
  { sourceId },
  { sort: { revision: -1 } },
);

const assertPublicationPolicy = (candidate, source, sandboxEnabled) => {
  const sandboxProbe = sandboxEnabled && source.permission === 'PROBE_REQUIRED';
  if (source.permission === 'PROBE_REQUIRED' && !sandboxProbe) {
    throw new Meteor.Error(
      'ingestion-probe-only',
      'This source is approved only for a private probe and cannot publish candidates.',
    );
  }

  if (`${candidate.sourceId}`.startsWith('SEN-')) {
    const policy = latestSourcePolicy(candidate.sourceId);
    const sandboxPermission = sandboxEnabled && candidate.sourceId === 'SEN-005';
    if (policy?.policyStatus === 'PERMISSION_EVIDENCE_REQUIRED' && !sandboxPermission) {
      throw new Meteor.Error(
        'ingestion-permission-evidence-required',
        'Retained republication permission evidence is required before this source can publish.',
      );
    }
    if (policy?.policyStatus !== 'MANUAL_INTAKE_APPROVED' && !sandboxPermission) {
      throw new Meteor.Error(
        'ingestion-policy-not-approved',
        'This sensitive source has not been approved for reviewed public projection.',
      );
    }
    if (candidate.reviewLane !== 'SENSITIVE'
        || candidate.privacyReviewRequired !== true
        || candidate.projectionEligibility !== 'REQUIRES_SENSITIVE_REVIEW'
        || candidate.normalizedFields?.listingType !== 'support_group') {
      throw new Meteor.Error(
        'ingestion-not-publishable',
        'This support candidate is missing its required sensitive-review controls.',
      );
    }
  } else if (!sandboxProbe) {
    throw new Meteor.Error(
      'ingestion-projection-not-implemented',
      'This source has no approved public projection yet and must remain private.',
    );
  }
};

const clockMinutes = value => {
  const text = asText(value, 40)?.toLowerCase();
  if (!text) return null;
  if (text === 'noon') return 12 * 60;
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (!match) return null;
  const rawHour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2] || '0', 10);
  if (rawHour < 1 || rawHour > 12 || minute < 0 || minute > 59) return null;
  const hour = (rawHour % 12) + (match[3] === 'pm' ? 12 : 0);
  return hour * 60 + minute;
};

const recurrenceParts = label => {
  const text = asText(label, 200);
  if (!text) return null;
  const range = '(.+?)(?:\\s*[–—-]\\s*(.+))?';
  const monthly = text.match(new RegExp(
    `^(Second|Third|Last) (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday) of the month,\\s*${range}$`,
    'i',
  ));
  const weekly = text.match(new RegExp(
    `^(?:Every )?(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)(?: at|,)\\s*${range}$`,
    'i',
  ));

  const match = monthly || weekly;
  if (!match) return null;
  const monthlyRule = Boolean(monthly);
  const ordinal = monthlyRule ? match[1].toLowerCase() : undefined;
  const dayName = monthlyRule ? match[2].toLowerCase() : match[1].toLowerCase();
  const startText = monthlyRule ? match[3] : match[2];
  const endText = monthlyRule ? match[4] : match[3];
  const startMinutes = clockMinutes(startText);
  const endMinutes = endText ? clockMinutes(endText) : null;
  if (startMinutes === null || (endText && endMinutes === null)) return null;
  return {
    frequency: monthlyRule ? 'monthly' : 'weekly',
    ordinal,
    weekday: DAY_INDEX[dayName],
    startMinutes,
    endMinutes,
  };
};

const atLocalTime = (day, minutes, timeZone) => moment.tz({
  year: day.year(),
  month: day.month(),
  day: day.date(),
  hour: Math.floor(minutes / 60),
  minute: minutes % 60,
  second: 0,
  millisecond: 0,
}, timeZone);

const monthlyDay = (month, weekday, ordinal) => {
  if (ordinal === 'last') {
    const end = month.clone().endOf('month').startOf('day');
    const offset = (end.day() - weekday + 7) % 7;
    return end.subtract(offset, 'days');
  }
  const position = ordinal === 'second' ? 2 : 3;
  const first = month.clone().startOf('month').startOf('day');
  const offset = (weekday - first.day() + 7) % 7;
  return first.add(offset + (position - 1) * 7, 'days');
};

/**
 * Expand only the grammar accepted by the protected support snapshots. Unknown
 * text fails closed rather than being guessed into a public date.
 */
export const expandSupportRecurrence = (
  label,
  from = new Date(),
  timeZone = HAWAII_TIME_ZONE,
  limit = DEFAULT_RECURRENCE_SAMPLE,
) => {
  const rule = recurrenceParts(label);
  if (!rule) {
    throw new Meteor.Error(
      'ingestion-unsupported-recurrence',
      'This recurring schedule must be corrected before it can publish.',
    );
  }
  const floor = moment.tz(from, timeZone);
  const occurrences = [];

  if (rule.frequency === 'weekly') {
    const day = floor.clone().startOf('day');
    while (occurrences.length < limit) {
      if (day.day() === rule.weekday) {
        const start = atLocalTime(day, rule.startMinutes, timeZone);
        if (start.isAfter(floor)) {
          let end;
          if (rule.endMinutes !== null) {
            end = atLocalTime(day, rule.endMinutes, timeZone);
            if (!end.isAfter(start)) end.add(1, 'day');
          }
          occurrences.push({ start: start.toDate(), ...(end ? { end: end.toDate() } : {}) });
        }
      }
      day.add(1, 'day');
    }
    return occurrences;
  }

  const month = floor.clone().startOf('month');
  while (occurrences.length < limit) {
    const day = monthlyDay(month, rule.weekday, rule.ordinal);
    const start = atLocalTime(day, rule.startMinutes, timeZone);
    if (start.isAfter(floor)) {
      let end;
      if (rule.endMinutes !== null) {
        end = atLocalTime(day, rule.endMinutes, timeZone);
        if (!end.isAfter(start)) end.add(1, 'day');
      }
      occurrences.push({ start: start.toDate(), ...(end ? { end: end.toDate() } : {}) });
    }
    month.add(1, 'month');
  }
  return occurrences;
};

export const ingestionPromotionCutoff = (
  referenceAt = new Date(),
  timeZone = HAWAII_TIME_ZONE,
) => moment.tz(referenceAt, timeZone).add(2, 'months').endOf('day').toDate();

const oneTimeOccurrence = (fields, timeZone) => {
  const value = asText(fields.localStart, 100);
  if (!value) {
    throw new Meteor.Error('ingestion-missing-date', 'This event candidate has no publishable date.');
  }

  let start;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) {
    start = moment.parseZone(value);
  } else {
    start = moment.tz(value, ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm'], true, timeZone);
  }
  if (!start.isValid()) {
    throw new Meteor.Error('ingestion-invalid-date', 'This event candidate has an invalid date.');
  }

  const endValue = asText(fields.localEnd, 100);
  if (!endValue) return [{ start: start.toDate() }];
  const end = /[zZ]|[+-]\d{2}:?\d{2}$/.test(endValue)
    ? moment.parseZone(endValue)
    : moment.tz(endValue, ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm'], true, timeZone);
  if (!end.isValid() || !end.isAfter(start)) {
    throw new Meteor.Error('ingestion-invalid-date', 'This event candidate has an invalid end date.');
  }
  if (end.diff(start, 'hours', true) > 24) {
    throw new Meteor.Error(
      'ingestion-event-duration-review-required',
      'Events longer than 24 hours require schedule correction before publication.',
    );
  }
  return [{ start: start.toDate(), end: end.toDate() }];
};

const eventScheduleWithinHorizon = (fields, referenceAt) => {
  const timeZone = asText(fields.timeZone, 100) || HAWAII_TIME_ZONE;
  if (timeZone !== HAWAII_TIME_ZONE) {
    throw new Meteor.Error(
      'ingestion-unsupported-time-zone',
      'The pilot projection supports only Pacific/Honolulu event times.',
    );
  }
  const recurrenceLabel = asText(fields.recurrenceLabel, 200);
  const generated = recurrenceLabel
    ? expandSupportRecurrence(
      recurrenceLabel,
      referenceAt,
      timeZone,
      MAX_PROJECTED_OCCURRENCES,
    )
    : oneTimeOccurrence(fields, timeZone);
  const cutoff = ingestionPromotionCutoff(referenceAt, timeZone);
  const referenceTime = referenceAt.getTime();
  const cutoffTime = cutoff.getTime();
  const occurrences = generated.filter(occurrence => (
    occurrence.start.getTime() > referenceTime
    && occurrence.start.getTime() <= cutoffTime
  ));
  return {
    timeZone,
    recurrenceLabel,
    occurrences,
    cutoff,
    withinHorizon: occurrences.length > 0,
  };
};

const effectiveApprovalValidation = (candidate, entityHint) => {
  const sourceValidationState = asText(candidate?.validationState, 80) || 'UNKNOWN';
  if (sourceValidationState === 'VALID') {
    return {
      sourceValidationState,
      effectiveValidationState: 'VALID',
      effectiveValidationBasis: 'SOURCE_VALIDATION',
    };
  }
  if (editorialRevisionFor(candidate) === 0 || entityHint !== 'event') {
    throw new Meteor.Error(
      'ingestion-effective-validation-required',
      'This source candidate is invalid and has no complete reviewed event correction.',
    );
  }

  const fields = effectiveNormalizedFields(candidate);
  const listingType = asText(fields.listingType, 80)?.toLowerCase();
  if (listingType && !['event', 'support_group'].includes(listingType)) {
    throw new Meteor.Error(
      'ingestion-not-publishable',
      'This corrected candidate is not an event MatchBook can publish.',
    );
  }
  const title = asText(fields.title, 200);
  const location = asText(fields.location, 300);
  if (!title || !location) {
    throw new Meteor.Error(
      'ingestion-missing-required-field',
      'This corrected event needs a title and location before it can publish.',
    );
  }
  assertPublicEventText(title, 'title');
  assertPublicEventText(location, 'location');

  const timeZone = asText(fields.timeZone, 100) || HAWAII_TIME_ZONE;
  if (timeZone !== HAWAII_TIME_ZONE) {
    throw new Meteor.Error(
      'ingestion-unsupported-time-zone',
      'The pilot projection supports only Pacific/Honolulu event times.',
    );
  }
  const recurrenceLabel = asText(fields.recurrenceLabel, 200);
  if (recurrenceLabel) {
    if (!recurrenceParts(recurrenceLabel)) {
      throw new Meteor.Error(
        'ingestion-unsupported-recurrence',
        'This corrected recurring schedule is not supported.',
      );
    }
  } else {
    oneTimeOccurrence(fields, timeZone);
  }
  return {
    sourceValidationState,
    effectiveValidationState: 'VALID',
    effectiveValidationBasis: 'EDITORIAL_REVALIDATION',
  };
};

const claimIsStale = candidate => (
  !(candidate.approvalClaimedAt instanceof Date)
  || candidate.approvalClaimedAt.getTime() < Date.now() - CLAIM_TTL_MS
);

const publicationIsComplete = candidate => (
  candidate.reviewStatus === 'APPROVED'
  && (candidate.publicationState === 'COMPLETE' || !candidate.publicationState)
);

const latestCandidateRevision = candidate => IngestionCandidates.findOne({
  sourceId: candidate.sourceId,
  sourceItemKey: candidate.sourceItemKey,
  reviewStatus: { $ne: 'SUPERSEDED' },
}, {
  sort: { lastObservedAt: -1, createdAt: -1, _id: -1 },
});

const assertLatestCandidateRevision = candidate => {
  const latest = latestCandidateRevision(candidate);
  if (!latest || `${latest._id}` !== `${candidate._id}`) {
    throw new Meteor.Error(
      'ingestion-candidate-superseded',
      'A newer revision exists for this source item. Review that revision instead.',
    );
  }
};

const dispositionRevisionFor = candidate => (
  Number.isInteger(candidate?.reviewDispositionRevision)
    && candidate.reviewDispositionRevision >= 0
    ? candidate.reviewDispositionRevision
    : 0
);

const dispositionRevisionSelector = revision => (
  revision === 0
    ? {
      $or: [
        { reviewDispositionRevision: { $exists: false } },
        { reviewDispositionRevision: 0 },
      ],
    }
    : { reviewDispositionRevision: revision }
);

const recordDispositionTransition = ({
  at,
  candidate,
  decision,
  fromStatus,
  reason,
  toStatus,
  userId,
}) => {
  const revisionBefore = dispositionRevisionFor(candidate);
  const revisionAfter = revisionBefore + 1;
  // Every CAS attempt owns a distinct audit row. If two administrators act on
  // the same revision concurrently, the losing attempt may mark only its own
  // row CONFLICT; it must never overwrite the winner's COMPLETE decision.
  const actionId = `candidate-disposition:${candidate._id}:${revisionAfter}:${crypto.randomBytes(12).toString('hex')}`;
  ReviewItems.upsert({ _id: actionId }, {
    $setOnInsert: {
      candidateId: `${candidate._id}`,
      sourceId: candidate.sourceId,
      observationId: candidate.observationId,
      status: 'RECORDED',
      decision,
      fromStatus,
      toStatus,
      reason,
      reviewedBy: userId,
      reviewedAt: at,
      dispositionRevisionBefore: revisionBefore,
      dispositionRevisionAfter: revisionAfter,
      createdAt: at,
      updatedAt: at,
      priority: 0,
    },
  });

  const setFields = {
    reviewStatus: toStatus,
    reviewDispositionRevision: revisionAfter,
    lastReviewDispositionActionId: actionId,
  };
  const unsetFields = {};
  if (toStatus === 'REJECTED') {
    Object.assign(setFields, {
      clearedAt: at,
      clearedBy: userId,
      clearReason: reason,
    });
  } else {
    Object.assign(unsetFields, {
      clearedAt: '',
      clearedBy: '',
      clearReason: '',
    });
  }
  const changed = IngestionCandidates.update({
    _id: candidate._id,
    reviewStatus: fromStatus,
    ...dispositionRevisionSelector(revisionBefore),
  }, {
    $set: setFields,
    ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
  });
  if (changed !== 1) {
    ReviewItems.update(actionId, {
      $set: { status: 'CONFLICT', updatedAt: at },
    });
    return {
      candidateId: `${candidate._id}`,
      outcome: 'SKIPPED',
      code: 'ingestion-candidate-disposition-conflict',
    };
  }
  ReviewItems.update(actionId, {
    $set: { status: 'COMPLETE', updatedAt: at },
  });
  return {
    actionId,
    candidateId: `${candidate._id}`,
    outcome: toStatus === 'REJECTED' ? 'CLEARED' : 'REOPENED',
  };
};

const changeCandidateReviewDisposition = ({
  at = new Date(),
  candidateIds,
  fromStatus,
  reason,
  toStatus,
  userId,
}) => {
  requireAdmin(userId);
  if (!Array.isArray(candidateIds) || candidateIds.length === 0) {
    throw new Meteor.Error(
      'ingestion-disposition-empty',
      'Choose at least one review candidate.',
    );
  }
  const requestedIds = unique(candidateIds.map(candidateId => `${candidateId}`));
  if (requestedIds.length > MAX_DISPOSITION_BATCH) {
    throw new Meteor.Error(
      'ingestion-disposition-too-large',
      `Review queue changes are limited to ${MAX_DISPOSITION_BATCH} candidates at a time.`,
    );
  }
  if (!CLEAR_REASONS.has(reason)) {
    throw new Meteor.Error('ingestion-invalid-clear-reason', 'That review queue reason is not supported.');
  }

  const breakdown = {
    requested: requestedIds.length,
    changed: 0,
    alreadyInState: 0,
    skipped: 0,
    results: [],
  };
  requestedIds.forEach(candidateId => {
    const candidate = IngestionCandidates.findOne(candidateId);
    if (!candidate) {
      breakdown.skipped += 1;
      breakdown.results.push({
        candidateId,
        outcome: 'SKIPPED',
        code: 'ingestion-candidate-not-found',
      });
      return;
    }
    if (candidate.reviewStatus === toStatus) {
      breakdown.alreadyInState += 1;
      breakdown.results.push({
        candidateId,
        outcome: toStatus === 'REJECTED' ? 'ALREADY_CLEARED' : 'ALREADY_REOPENED',
      });
      return;
    }
    if (candidate.reviewStatus !== fromStatus) {
      breakdown.skipped += 1;
      breakdown.results.push({
        candidateId,
        outcome: 'SKIPPED',
        code: fromStatus === 'PENDING'
          ? 'ingestion-candidate-not-pending'
          : 'ingestion-candidate-not-cleared',
      });
      return;
    }
    try {
      assertLatestCandidateRevision(candidate);
      const result = recordDispositionTransition({
        at,
        candidate,
        decision: toStatus === 'REJECTED' ? 'CLEAR_CANDIDATE' : 'REOPEN_CANDIDATE',
        fromStatus,
        reason,
        toStatus,
        userId,
      });
      if (result.outcome === 'SKIPPED') breakdown.skipped += 1;
      else breakdown.changed += 1;
      breakdown.results.push(result);
    } catch (error) {
      breakdown.skipped += 1;
      breakdown.results.push({
        candidateId,
        outcome: 'SKIPPED',
        code: `${error?.error || error?.message || 'ingestion-disposition-failed'}`,
      });
    }
  });
  return breakdown;
};

export const clearCandidatesFromReview = (
  candidateIds,
  userId,
  reason = 'REVIEWED_SKIP',
  at = new Date(),
) => changeCandidateReviewDisposition({
  at,
  candidateIds,
  fromStatus: 'PENDING',
  reason,
  toStatus: 'REJECTED',
  userId,
});

export const reopenClearedCandidates = (
  candidateIds,
  userId,
  at = new Date(),
) => changeCandidateReviewDisposition({
  at,
  candidateIds,
  fromStatus: 'REJECTED',
  reason: 'REVIEWED_SKIP',
  toStatus: 'PENDING',
  userId,
});

const verifiedCandidateData = (candidate, { enforcePublicationPolicy = true } = {}) => {
  const source = CommunitySources.findOne(candidate.sourceId);
  if (!source) {
    throw new Meteor.Error('ingestion-source-not-found', 'The candidate source could not be found.');
  }
  if (enforcePublicationPolicy) {
    assertPublicationPolicy(candidate, source, communityIngestionSandboxEnabled());
  }

  const observation = SourceObservations.findOne(candidate.observationId);
  if (!observation
      || observation.sourceId !== candidate.sourceId
      || observation.sourceItemKey !== candidate.sourceItemKey) {
    throw new Meteor.Error(
      'ingestion-observation-mismatch',
      'The immutable observation for this candidate could not be verified.',
    );
  }

  let inferredKind;
  if (`${candidate.sourceItemKey}`.startsWith('group:')) inferredKind = 'group';
  if (`${candidate.sourceItemKey}`.startsWith('event:')) inferredKind = 'event';
  const entityHint = candidate.entityHint || observation.entityHint || inferredKind;
  if (!['group', 'event'].includes(entityHint)) {
    throw new Meteor.Error(
      'ingestion-not-publishable',
      'This candidate is not an event or group that MatchBook can publish.',
    );
  }
  if (enforcePublicationPolicy
      && entityHint === 'group'
      && !isSensitiveSupportCandidate(candidate)) {
    throw new Meteor.Error(
      'ingestion-projection-not-implemented',
      'Only protected support groups have an approved public group projection.',
    );
  }

  const sourceUrl = publicSourceUrl(candidate, observation, source);
  if (`${candidate.sourceId}`.startsWith('SEN-')) {
    // The sandbox may waive collection permission for a local human review,
    // but it never waives the protected support payload scan.
    assertSensitivePayload(effectiveNormalizedFields(candidate), sourceUrl);
  }
  return { source, observation, entityHint, sourceUrl };
};

const candidateContext = candidateId => {
  const candidate = IngestionCandidates.findOne(candidateId);
  if (!candidate) {
    throw new Meteor.Error('ingestion-candidate-not-found', 'That intake candidate could not be found.');
  }
  assertLatestCandidateRevision(candidate);
  if (publicationIsComplete(candidate)) {
    return { candidate, alreadyApproved: true };
  }
  const retryPublication = candidate.reviewStatus === 'APPROVED'
    && (candidate.publicationState === 'FAILED'
      || (candidate.publicationState === 'APPLYING' && claimIsStale(candidate)));
  if (candidate.reviewStatus === 'APPROVED' && !retryPublication) {
    throw new Meteor.Error(
      'ingestion-approval-in-progress',
      'Another review is already publishing this approved candidate.',
    );
  }
  const staleApproval = candidate.reviewStatus === 'APPROVING' && claimIsStale(candidate);
  if (candidate.reviewStatus !== 'PENDING' && !staleApproval && !retryPublication) {
    throw new Meteor.Error(
      'ingestion-candidate-not-pending',
      'Only pending candidates or interrupted approved publications can be processed.',
    );
  }

  const verified = verifiedCandidateData(candidate);
  const effectiveValidation = effectiveApprovalValidation(candidate, verified.entityHint);
  return {
    candidate,
    ...verified,
    effectiveValidation,
    alreadyApproved: false,
    retryPublication,
  };
};

const provenance = (source, sourceUrl, verifiedAt) => ({
  publisher: asText(source.publisherName || source.displayName, 200) || 'Community source',
  ...(sourceUrl ? { url: sourceUrl } : {}),
  ...(asText(verifiedAt, 50) ? { lastChecked: asText(verifiedAt, 50).slice(0, 10) } : {}),
});

const supportDescription = fields => SUBTYPE_DESCRIPTIONS[fields.supportSubtype]
  || 'A recurring community support group.';

const groupLocation = fields => {
  const locations = unique(asStringList(fields.locationLabels, 100, 300));
  if (locations.length === 1) return locations[0];
  if (locations.length > 1) return 'Multiple locations; see the official source';
  return asText(fields.location, 300);
};

const groupMeetingTime = fields => {
  const labels = unique(asStringList(fields.recurrenceLabels, 100, 160));
  return labels.length ? labels.join('; ') : asText(fields.recurrenceLabel, 160);
};

const canonicalSourceId = (sourceId, kind, keyHash, occurrenceDate) => (
  `community:${sourceId}:${kind}:${keyHash}${occurrenceDate ? `@${occurrenceDate}` : ''}`
);

const projectionLockId = candidate => (
  `projection-lock:${candidate.sourceId}:${sourceKeyHash(candidate.sourceItemKey)}`
);

const projectionLockFields = (candidate, token, now) => ({
  sourceId: candidate.sourceId,
  keyType: 'projection_lock',
  keyHash: sourceKeyHash(candidate.sourceItemKey),
  projectionCandidateId: `${candidate._id}`,
  projectionLockToken: token,
  projectionLockUntil: new Date(now.getTime() + CLAIM_TTL_MS),
  projectionLockUpdatedAt: now,
});

const duplicateKeyError = error => (
  error?.code === 11000
  || error?.error === 11000
  || /E11000|duplicate key/i.test(`${error?.message || error?.reason || ''}`)
);

const acquireProjectionLock = (candidate, now = new Date()) => {
  const id = projectionLockId(candidate);
  const token = crypto.randomUUID();
  const fields = projectionLockFields(candidate, token, now);
  let acquired = SourceEntityKeys.update({
    _id: id,
    keyType: 'projection_lock',
    $or: [
      { projectionLockToken: { $exists: false } },
      { projectionLockUntil: { $lt: now } },
      { projectionLockUntil: { $exists: false } },
    ],
  }, { $set: fields });

  if (acquired !== 1) {
    try {
      SourceEntityKeys.insert({ _id: id, ...fields, createdAt: now });
      acquired = 1;
    } catch (error) {
      if (!duplicateKeyError(error)) throw error;
    }
  }
  if (acquired !== 1) {
    throw new Meteor.Error(
      'ingestion-source-item-projection-in-progress',
      'Another approved revision is currently publishing this source item.',
    );
  }
  return { id, token, candidateId: `${candidate._id}` };
};

const renewProjectionLock = projectionLock => {
  if (!projectionLock) {
    throw new Meteor.Error(
      'ingestion-projection-lock-lost',
      'The source-item publication lock is missing.',
    );
  }
  const now = new Date();
  const renewed = SourceEntityKeys.update({
    _id: projectionLock.id,
    keyType: 'projection_lock',
    projectionCandidateId: projectionLock.candidateId,
    projectionLockToken: projectionLock.token,
    projectionLockUntil: { $gte: now },
  }, {
    $set: {
      projectionLockUntil: new Date(now.getTime() + CLAIM_TTL_MS),
      projectionLockUpdatedAt: now,
    },
  });
  if (renewed !== 1) {
    throw new Meteor.Error(
      'ingestion-projection-lock-lost',
      'The source-item publication lock expired or was reclaimed.',
    );
  }
};

const releaseProjectionLock = projectionLock => {
  if (!projectionLock) return;
  SourceEntityKeys.update({
    _id: projectionLock.id,
    projectionCandidateId: projectionLock.candidateId,
    projectionLockToken: projectionLock.token,
  }, {
    $set: { projectionLockReleasedAt: new Date() },
    $unset: {
      projectionCandidateId: '',
      projectionLockToken: '',
      projectionLockUntil: '',
      projectionLockUpdatedAt: '',
    },
  });
};

const reopenReobservedApprovedCandidate = (projectedCandidate, projectionLock) => {
  renewProjectionLock(projectionLock);
  const latest = latestCandidateRevision(projectedCandidate);
  if (!latest
      || `${latest._id}` === `${projectedCandidate._id}`
      || !publicationIsComplete(latest)) return null;

  const latestBinding = editorialBindingFor(latest);
  const latestDecision = ReviewItems.findOne(approvalDecisionIdFor(latest, latestBinding));
  assertDurableEditorialBinding(latest, latestDecision, latestBinding);

  const reopened = IngestionCandidates.update({
    _id: latest._id,
    sourceId: projectedCandidate.sourceId,
    sourceItemKey: projectedCandidate.sourceItemKey,
    reviewStatus: 'APPROVED',
    ...(Number.isInteger(latest.approvalEditorialRevision) ? {
      approvalEditorialRevision: latestBinding.editorialRevision,
      approvalEffectiveFieldsHash: latestBinding.effectiveFieldsHash,
    } : {}),
    $or: [
      { publicationState: 'COMPLETE' },
      { publicationState: { $exists: false } },
    ],
  }, {
    $set: { reviewStatus: 'PENDING' },
    $unset: {
      publicationState: '',
      reviewedAt: '',
      reviewedBy: '',
      projectionVersion: '',
      projectionReferenceAt: '',
      canonicalTargets: '',
      approvalClaimToken: '',
      approvalClaimedAt: '',
      approvalClaimedBy: '',
      approvalEditorialRevision: '',
      approvalEffectiveFieldsHash: '',
      approvalDecisionId: '',
      approvalSourceValidationState: '',
      approvalEffectiveValidationState: '',
      approvalEffectiveValidationBasis: '',
      lastProjectionErrorCode: '',
    },
  });
  renewProjectionLock(projectionLock);
  return reopened === 1 ? `${latest._id}` : null;
};

const upsertSourceEntityKey = ({
  candidate,
  kind,
  keyHash,
  canonicalIds,
  canonicalSourceIds,
  parentKeyHash,
  now,
  projectionLock,
}) => {
  renewProjectionLock(projectionLock);
  const id = `source-key:${candidate.sourceId}:${kind}:${keyHash}`;
  SourceEntityKeys.upsert({ _id: id }, {
    $set: {
      sourceId: candidate.sourceId,
      keyType: kind,
      keyHash,
      canonicalCollection: kind === 'group' ? Clubs.name : Events.name,
      canonicalIds,
      canonicalSourceIds,
      candidateFingerprint: candidate.fingerprint || candidate._id,
      observationId: candidate.observationId,
      projectionVersion: PROJECTION_VERSION,
      updatedAt: now,
      ...(parentKeyHash ? { parentKeyHash } : {}),
    },
    $setOnInsert: { createdAt: now },
  });
  return SourceEntityKeys.findOne(id);
};

const existingParentGroup = (sourceId, parentKeyHash) => {
  if (!parentKeyHash) return null;
  const mapping = SourceEntityKeys.findOne({ sourceId, keyType: 'group', keyHash: parentKeyHash });
  const canonicalId = mapping?.canonicalIds?.[0];
  const club = canonicalId ? Clubs.collection.findOne(canonicalId) : null;
  return club && club.publicationStatus !== 'draft' ? club : null;
};

const linkEventToGroup = (event, club, now, projectionLock) => {
  if (!event || !club || event.publicationStatus === 'draft' || club.publicationStatus === 'draft') return;
  renewProjectionLock(projectionLock);
  Events.collection.update(event._id, {
    $set: { eventID: club.clubID, hostName: club.name, updatedAt: now },
  });
  renewProjectionLock(projectionLock);
  EventClubs.collection.upsert({ clubId: club._id, eventId: event._id }, {
    $setOnInsert: {
      clubId: club._id,
      eventId: event._id,
      userId: SOURCE_MANAGED_LINK_ACTOR,
      createdAt: now,
    },
  });
};

const replaceSourceManagedEventLink = (event, club, now, projectionLock) => {
  if (!event) return;
  renewProjectionLock(projectionLock);
  EventClubs.collection.remove({
    eventId: event._id,
    userId: SOURCE_MANAGED_LINK_ACTOR,
  });
  if (club) linkEventToGroup(event, club, now, projectionLock);
};

const reconcileGroupEvents = (sourceId, parentKeyHash, club, now, projectionLock) => {
  SourceEntityKeys.find({ sourceId, keyType: 'event', parentKeyHash }).forEach(mapping => {
    renewProjectionLock(projectionLock);
    const eventCandidate = IngestionCandidates.findOne({ fingerprint: mapping.candidateFingerprint });
    if (!eventCandidate) return;
    let eventProjectionLock;
    try {
      eventProjectionLock = acquireProjectionLock(eventCandidate);
      try {
        assertLatestCandidateRevision(eventCandidate);
      } catch (error) {
        if (error?.error === 'ingestion-candidate-superseded') return;
        throw error;
      }
      const currentMapping = SourceEntityKeys.findOne(mapping._id);
      if (currentMapping?.parentKeyHash !== parentKeyHash
          || currentMapping?.candidateFingerprint !== eventCandidate.fingerprint) return;
      (currentMapping.canonicalIds || []).forEach(eventId => {
        const event = Events.collection.findOne(eventId);
        if (event?.publicationStatus !== 'draft') {
          replaceSourceManagedEventLink(event, club, now, eventProjectionLock);
        }
      });
    } finally {
      releaseProjectionLock(eventProjectionLock);
    }
  });
};

const comparableText = value => (asText(value, 500) || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  // Hawaiian ʻokina and typographic apostrophes are word-internal marks;
  // turning them into spaces makes Līhuʻe incomparable with Lihue.
  .replace(/[\u02bb\u2018\u2019'`]/g, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const editDistance = (left, right) => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const current = [leftIndex + 1];
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitution = previous[rightIndex]
        + (left[leftIndex] === right[rightIndex] ? 0 : 1);
      current.push(Math.min(
        current[rightIndex] + 1,
        previous[rightIndex + 1] + 1,
        substitution,
      ));
    }
    previous = current;
  }
  return previous[right.length];
};

const textSimilarity = (left, right) => {
  const normalizedLeft = comparableText(left);
  const normalizedRight = comparableText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  const length = Math.max(normalizedLeft.length, normalizedRight.length);
  const editSimilarity = 1 - (editDistance(normalizedLeft, normalizedRight) / length);
  const leftTokens = new Set(normalizedLeft.split(' '));
  const rightTokens = new Set(normalizedRight.split(' '));
  const intersection = [...leftTokens].filter(token => rightTokens.has(token)).length;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  const containment = smaller ? intersection / smaller : 0;
  const dice = (leftTokens.size + rightTokens.size)
    ? (2 * intersection) / (leftTokens.size + rightTokens.size)
    : 0;
  // Containment catches a canonical venue name embedded in a full street
  // address; Dice prevents one incidental shared token from scoring as exact.
  const tokenSimilarity = (containment * 0.75) + (dice * 0.25);
  return Math.round(Math.max(editSimilarity, tokenSimilarity) * 100) / 100;
};

const SCHEDULE_DAY_ALIASES = Object.freeze([
  ['sunday', /\b(?:sun|sundays?)\b/g],
  ['monday', /\b(?:mon|mondays?)\b/g],
  ['tuesday', /\b(?:tue|tues|tuesdays?)\b/g],
  ['wednesday', /\b(?:wed|weds|wednesdays?)\b/g],
  ['thursday', /\b(?:thu|thur|thurs|thursdays?)\b/g],
  ['friday', /\b(?:fri|fridays?)\b/g],
  ['saturday', /\b(?:sat|saturdays?)\b/g],
]);

const comparableSchedule = value => {
  let normalized = comparableText(value)
    .replace(/\ba m\b/g, 'am')
    .replace(/\bp m\b/g, 'pm')
    .replace(/\bnoon\b/g, '12 00 pm')
    .replace(/\bmidnight\b/g, '12 00 am');
  SCHEDULE_DAY_ALIASES.forEach(([day, pattern]) => {
    normalized = normalized.replace(pattern, day);
  });
  return normalized
    .replace(/\b(?:at|on|every|each|weekly|the)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const scheduleAnchors = value => {
  const raw = asText(value, 500) || '';
  const normalized = comparableSchedule(raw);
  const weekdays = Object.keys(DAY_INDEX).filter(day => (
    new RegExp(`\\b${day}\\b`).test(normalized)
  ));
  const clocks = [];
  const clockPattern = /\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(a\.?\s*m\.?|p\.?\s*m\.?)\b/gi;
  let clockMatch = clockPattern.exec(raw);
  while (clockMatch) {
    let hour = Number(clockMatch[1]);
    const minute = Number(clockMatch[2] || 0);
    const meridiem = clockMatch[3].replace(/[^ap]/gi, '').toLowerCase();
    if (hour === 12) hour = 0;
    if (meridiem === 'p') hour += 12;
    clocks.push({ index: clockMatch.index, minuteOfDay: (hour * 60) + minute });
    clockMatch = clockPattern.exec(raw);
  }
  const noonIndex = raw.search(/\bnoon\b/i);
  if (noonIndex >= 0) clocks.push({ index: noonIndex, minuteOfDay: 12 * 60 });
  const midnightIndex = raw.search(/\bmidnight\b/i);
  if (midnightIndex >= 0) clocks.push({ index: midnightIndex, minuteOfDay: 0 });
  clocks.sort((left, right) => left.index - right.index);
  return {
    normalized,
    weekdays,
    startMinute: clocks[0]?.minuteOfDay,
  };
};

const scheduleSimilarity = (left, right) => {
  const leftAnchors = scheduleAnchors(left);
  const rightAnchors = scheduleAnchors(right);
  if (!leftAnchors.normalized || !rightAnchors.normalized) return 0;
  if (leftAnchors.weekdays.length && rightAnchors.weekdays.length
      && !leftAnchors.weekdays.some(day => rightAnchors.weekdays.includes(day))) return 0;
  if (leftAnchors.startMinute !== undefined && rightAnchors.startMinute !== undefined
      && Math.abs(leftAnchors.startMinute - rightAnchors.startMinute) > 30) return 0;
  const anchorsAgree = leftAnchors.weekdays.length
    && rightAnchors.weekdays.length
    && leftAnchors.startMinute !== undefined
    && rightAnchors.startMinute !== undefined;
  return Math.max(
    textSimilarity(leftAnchors.normalized, rightAnchors.normalized),
    anchorsAgree ? 0.85 : 0,
  );
};

const maxSimilarity = (leftValues, rightValues, similarity = textSimilarity) => (
  leftValues.reduce((highest, left) => Math.max(
    highest,
    ...rightValues.map(right => similarity(left, right)),
  ), 0)
);

const VENUE_STOP_WORDS = new Set([
  'at', 'the', 'public', 'hi', 'hawaii', 'street', 'st', 'road', 'rd',
  'avenue', 'ave', 'highway', 'hwy', 'drive', 'dr', 'lane', 'ln', 'suite', 'unit',
]);

const comparableVenue = value => comparableText(value).split(' ')
  .filter(token => token && !VENUE_STOP_WORDS.has(token) && !/^\d+$/.test(token))
  .slice(0, 4)
  .join(' ');

const venueSimilarity = (left, right) => Math.max(
  textSimilarity(left, right),
  textSimilarity(comparableVenue(left), comparableVenue(right)),
);

const duplicateSummary = matches => {
  const duplicates = matches
    .sort((left, right) => {
      const severity = (right.level === 'BLOCK' ? 1 : 0) - (left.level === 'BLOCK' ? 1 : 0);
      return severity
        || right.titleSimilarity - left.titleSimilarity
        || right.locationSimilarity - left.locationSimilarity
        || (right.scheduleSimilarity || 0) - (left.scheduleSimilarity || 0)
        || (left.minuteDelta || 0) - (right.minuteDelta || 0);
    })
    .slice(0, MAX_DUPLICATE_MATCHES);
  let duplicateLevel = 'NONE';
  if (duplicates.length) duplicateLevel = 'REVIEW';
  if (duplicates.some(match => match.level === 'BLOCK')) duplicateLevel = 'BLOCK';
  return { duplicates, duplicateLevel };
};

const duplicateLevelFor = ({ titleSimilarity, locationSimilarity, minuteDelta }) => {
  if (titleSimilarity >= DUPLICATE_BLOCK_TITLE
      && locationSimilarity >= DUPLICATE_BLOCK_LOCATION
      && minuteDelta <= DUPLICATE_BLOCK_MINUTES) return 'BLOCK';
  if (titleSimilarity >= DUPLICATE_REVIEW_TITLE
      && locationSimilarity >= DUPLICATE_REVIEW_LOCATION
      && minuteDelta <= DUPLICATE_REVIEW_MINUTES) return 'REVIEW';
  return 'NONE';
};

const duplicateAnalysis = ({ candidate, title, location, occurrences }) => {
  const keyHash = sourceKeyHash(candidate.sourceItemKey);
  const ownedPrefix = canonicalSourceId(candidate.sourceId, 'event', keyHash);
  const byId = new Map();
  occurrences.forEach(occurrence => {
    const lower = new Date(occurrence.start.getTime() - (DUPLICATE_REVIEW_MINUTES * 60 * 1000));
    const upper = new Date(occurrence.start.getTime() + (DUPLICATE_REVIEW_MINUTES * 60 * 1000));
    Events.collection.find({
      date: { $gte: lower, $lte: upper },
      publicationStatus: { $nin: ['draft', 'archived'] },
    }, {
      fields: { title: 1, date: 1, location: 1, sourceId: 1 },
      limit: 250,
    }).forEach(event => {
      if (`${event.sourceId || ''}`.startsWith(ownedPrefix)) return;
      const minuteDelta = Math.round(Math.abs(
        event.date.getTime() - occurrence.start.getTime(),
      ) / (60 * 1000));
      const titleSimilarity = textSimilarity(title, event.title);
      const locationSimilarity = venueSimilarity(location, event.location);
      const level = duplicateLevelFor({ titleSimilarity, locationSimilarity, minuteDelta });
      if (level === 'NONE') return;
      const safeMatch = {
        id: `${event._id}`,
        title: asText(event.title, 200),
        date: event.date,
        location: asText(event.location, 300),
        titleSimilarity,
        locationSimilarity,
        minuteDelta,
        level,
      };
      const previous = byId.get(safeMatch.id);
      if (!previous
          || (previous.level === 'REVIEW' && level === 'BLOCK')
          || (previous.level === level && minuteDelta < previous.minuteDelta)) {
        byId.set(safeMatch.id, safeMatch);
      }
    });
  });
  return duplicateSummary([...byId.values()]);
};

const groupDuplicateLevelFor = ({
  titleSimilarity,
  locationSimilarity,
  scheduleSimilarity: meetingSimilarity,
}) => {
  if (titleSimilarity >= GROUP_DUPLICATE_BLOCK_NAME
      && locationSimilarity >= GROUP_DUPLICATE_BLOCK_LOCATION
      && meetingSimilarity >= GROUP_DUPLICATE_BLOCK_SCHEDULE) return 'BLOCK';
  if (titleSimilarity >= GROUP_DUPLICATE_REVIEW_NAME
      && locationSimilarity >= GROUP_DUPLICATE_REVIEW_LOCATION
      && meetingSimilarity >= GROUP_DUPLICATE_REVIEW_SCHEDULE) return 'REVIEW';
  return 'NONE';
};

const groupDuplicateAnalysis = ({
  candidate,
  title,
  locationValues,
  scheduleValues,
}) => {
  const keyHash = sourceKeyHash(candidate.sourceItemKey);
  const ownedSourceId = canonicalSourceId(candidate.sourceId, 'group', keyHash);
  const matches = [];
  Clubs.collection.find({
    publicationStatus: { $nin: ['draft', 'archived'] },
  }, {
    fields: {
      name: 1,
      location: 1,
      meetingTime: 1,
      sourceId: 1,
    },
    limit: 1000,
  }).forEach(club => {
    if (`${club.sourceId || ''}` === ownedSourceId) return;
    const existingLocations = [asText(club.location, 300)].filter(Boolean);
    const existingSchedules = (asText(club.meetingTime, 500) || '')
      .split(';')
      .map(value => asText(value, 160))
      .filter(Boolean);
    if (!existingLocations.length || !existingSchedules.length) return;
    const titleSimilarity = textSimilarity(title, club.name);
    const locationSimilarity = maxSimilarity(locationValues, existingLocations, venueSimilarity);
    const meetingSimilarity = maxSimilarity(
      scheduleValues,
      existingSchedules,
      scheduleSimilarity,
    );
    const level = groupDuplicateLevelFor({
      titleSimilarity,
      locationSimilarity,
      scheduleSimilarity: meetingSimilarity,
    });
    if (level === 'NONE') return;
    matches.push({
      id: `${club._id}`,
      title: asText(club.name, 200),
      location: asText(club.location, 300),
      meetingTime: asText(club.meetingTime, 500),
      titleSimilarity,
      locationSimilarity,
      scheduleSimilarity: meetingSimilarity,
      level,
    });
  });
  return duplicateSummary(matches);
};

const venueSlotKey = value => {
  const tokens = comparableText(value).split(' ')
    .filter(token => token && !VENUE_STOP_WORDS.has(token) && !/^\d+$/.test(token))
    .slice(0, 4)
    .sort();
  return tokens.join('-') || comparableText(value);
};

const titleSlotKey = value => {
  const stopWords = new Set([
    'a', 'an', 'and', 'at', 'event', 'for', 'group', 'meeting', 'of', 'support', 'the',
  ]);
  const tokens = comparableText(value).split(' ')
    .filter(token => token && !stopWords.has(token))
    .slice(0, 6)
    .sort();
  return tokens.join('-') || comparableText(value);
};

const scheduleSlotKey = value => {
  const anchors = scheduleAnchors(value);
  const dayKey = anchors.weekdays.slice().sort().join('-') || 'unknown-day';
  const timeKey = anchors.startMinute === undefined ? 'unknown-time' : `${anchors.startMinute}`;
  if (anchors.weekdays.length && anchors.startMinute !== undefined) return `${dayKey}:${timeKey}`;
  return `${dayKey}:${timeKey}:${hash(anchors.normalized).slice(0, 8)}`;
};

const eventDuplicateSlotSeeds = plan => unique(plan.occurrences.flatMap(occurrence => {
  const localDay = moment(occurrence.start).tz(HAWAII_TIME_ZONE).format('YYYY-MM-DD');
  const utcDay = moment.utc(occurrence.start).format('YYYY-MM-DD');
  return [
    // The coarse day locks make differently worded/title/location variants
    // share at least one fence; exact slots below reduce avoidable contention.
    `event:local-day:${localDay}`,
    `event:utc-day:${utcDay}`,
    `event:venue:${localDay}:${venueSlotKey(plan.location)}`,
    `event:title:${localDay}:${titleSlotKey(plan.title)}`,
  ];
}));

const groupDuplicateSlotSeeds = plan => {
  const scheduleKeys = unique(plan.scheduleValues.map(scheduleSlotKey));
  const venueKeys = unique(plan.locationValues.map(venueSlotKey));
  return unique([
    // Group records have no canonical date. A single short-lived global group
    // fence is deliberately conservative and guarantees a fuzzy recheck.
    'group:all',
    ...scheduleKeys.flatMap(scheduleKey => venueKeys.map(
      venueKey => `group:venue:${scheduleKey}:${venueKey}`,
    )),
    ...scheduleKeys.map(scheduleKey => `group:title:${scheduleKey}:${titleSlotKey(plan.title)}`),
  ]);
};

const releaseDuplicateSlotLocks = locks => {
  if (!locks) return;
  locks.ids.forEach(id => {
    SourceEntityKeys.update({
      _id: id,
      keyType: 'duplicate_slot_lock',
      duplicateSlotCandidateId: locks.candidateId,
      duplicateSlotToken: locks.token,
    }, {
      $set: { duplicateSlotReleasedAt: new Date() },
      $unset: {
        duplicateSlotCandidateId: '',
        duplicateSlotToken: '',
        duplicateSlotUntil: '',
        duplicateSlotUpdatedAt: '',
      },
    });
  });
};

const acquireDuplicateSlotLocks = (candidate, requestedSeeds, now = new Date()) => {
  const seeds = unique(requestedSeeds).sort();
  if (seeds.length > MAX_DUPLICATE_SLOT_LOCKS) {
    throw new Meteor.Error(
      'ingestion-duplicate-slot-limit',
      'This listing has too many schedules to compare safely in one publication.',
    );
  }
  const token = crypto.randomUUID();
  const candidateId = `${candidate._id}`;
  const acquired = { token, candidateId, ids: [] };
  try {
    seeds.forEach(seed => {
      const keyHash = hash(seed);
      const id = `duplicate-slot:${keyHash}`;
      const fields = {
        sourceId: candidate.sourceId,
        keyType: 'duplicate_slot_lock',
        keyHash,
        duplicateSlotCandidateId: candidateId,
        duplicateSlotToken: token,
        duplicateSlotUntil: new Date(now.getTime() + CLAIM_TTL_MS),
        duplicateSlotUpdatedAt: now,
      };
      let lockClaimed = SourceEntityKeys.update({
        _id: id,
        keyType: 'duplicate_slot_lock',
        $or: [
          { duplicateSlotToken: { $exists: false } },
          { duplicateSlotUntil: { $lt: now } },
          { duplicateSlotUntil: { $exists: false } },
        ],
      }, { $set: fields });
      if (lockClaimed !== 1) {
        try {
          SourceEntityKeys.insert({ _id: id, ...fields, createdAt: now });
          lockClaimed = 1;
        } catch (error) {
          if (!duplicateKeyError(error)) throw error;
        }
      }
      if (lockClaimed !== 1) {
        throw new Meteor.Error(
          'ingestion-duplicate-slot-in-progress',
          'Another reviewer is publishing a potentially matching listing. Retry after it finishes.',
        );
      }
      acquired.ids.push(id);
    });
    return acquired;
  } catch (error) {
    releaseDuplicateSlotLocks(acquired);
    throw error;
  }
};

const renewDuplicateSlotLocks = locks => {
  if (!locks) {
    throw new Meteor.Error(
      'ingestion-duplicate-slot-lock-lost',
      'The duplicate-projection lock is missing.',
    );
  }
  const now = new Date();
  locks.ids.forEach(id => {
    const renewed = SourceEntityKeys.update({
      _id: id,
      keyType: 'duplicate_slot_lock',
      duplicateSlotCandidateId: locks.candidateId,
      duplicateSlotToken: locks.token,
      duplicateSlotUntil: { $gte: now },
    }, {
      $set: {
        duplicateSlotUntil: new Date(now.getTime() + CLAIM_TTL_MS),
        duplicateSlotUpdatedAt: now,
      },
    });
    if (renewed !== 1) {
      throw new Meteor.Error(
        'ingestion-duplicate-slot-lock-lost',
        'A duplicate-projection lock expired or was reclaimed.',
      );
    }
  });
};

const localClock = fields => {
  const value = asText(fields.localStart, 100);
  if (!value) return 'no-clock';
  const parsed = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value)
    ? moment.parseZone(value).tz(HAWAII_TIME_ZONE)
    : moment.tz(value, ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm'], true, HAWAII_TIME_ZONE);
  return parsed.isValid() ? parsed.format('HH:mm') : 'invalid-clock';
};

const seriesKeyFor = context => {
  const { candidate, observation } = context;
  const fields = effectiveNormalizedFields(candidate);
  let seed;
  if (asText(candidate.recurringSeriesKey, 500)) {
    seed = `worker:${asText(candidate.recurringSeriesKey, 500)}`;
  } else if (asText(candidate.parentSourceItemKey, 500)) {
    seed = `parent:${asText(candidate.parentSourceItemKey, 500)}`;
  } else if (`${candidate.sourceItemKey}`.startsWith('group:')) {
    seed = `parent:${candidate.sourceItemKey}`;
  } else if (asText(observation.rawFields?.groupKey, 200)) {
    seed = `parent:group:${asText(observation.rawFields.groupKey, 200)}`;
  } else {
    // Legacy core candidates are separate dated rows. Title, location, and
    // local clock recover the recurring series without using the date itself.
    seed = [
      'legacy',
      comparableText(fields.title),
      comparableText(fields.location),
      localClock(fields),
    ].join(':');
  }
  return `series:${candidate.sourceId}:${hash(seed).slice(0, 24)}`;
};

const seriesMembershipForCandidate = candidateId => {
  const candidate = IngestionCandidates.findOne(candidateId);
  if (!candidate) {
    throw new Meteor.Error('ingestion-candidate-not-found', 'That intake candidate could not be found.');
  }
  assertLatestCandidateRevision(candidate);
  const observation = SourceObservations.findOne(candidate.observationId);
  if (!observation
      || observation.sourceId !== candidate.sourceId
      || observation.sourceItemKey !== candidate.sourceItemKey) {
    throw new Meteor.Error(
      'ingestion-observation-mismatch',
      'The immutable observation for this candidate could not be verified.',
    );
  }
  return { candidate, seriesKey: seriesKeyFor({ candidate, observation }) };
};

const eventPromotionBasePlan = (context, referenceAt, reviewOptions = {}) => {
  const fields = effectiveNormalizedFields(context.candidate);
  const title = asText(fields.title, 200);
  const location = asText(fields.location, 300);
  if (!title || !location) {
    throw new Meteor.Error(
      'ingestion-missing-required-field',
      'This event needs a title and location before it can publish.',
    );
  }
  if (!isSensitiveSupportCandidate(context.candidate)) {
    assertPublicEventText(title, 'title');
    assertPublicEventText(location, 'location');
  }
  const schedule = eventScheduleWithinHorizon(fields, referenceAt);
  const classification = effectiveClassification(context.candidate, reviewOptions);
  return {
    ...schedule,
    title,
    location,
    classification,
    seriesKey: seriesKeyFor(context),
    isSupport: isSensitiveSupportCandidate(context.candidate),
  };
};

const eventPromotionPlan = (context, referenceAt, reviewOptions = {}) => {
  const base = eventPromotionBasePlan(context, referenceAt, reviewOptions);
  return {
    ...base,
    ...duplicateAnalysis({
      candidate: context.candidate,
      title: base.title,
      location: base.location,
      occurrences: base.occurrences,
    }),
  };
};

const groupPromotionBasePlan = context => {
  const fields = effectiveNormalizedFields(context.candidate);
  const title = asText(fields.title, 200);
  const location = groupLocation(fields);
  const meetingTime = groupMeetingTime(fields);
  if (!title || !location || !meetingTime) {
    throw new Meteor.Error(
      'ingestion-missing-required-field',
      'This group needs a title, location, and schedule before it can publish.',
    );
  }
  return {
    title,
    location,
    meetingTime,
    locationValues: unique([
      ...asStringList(fields.locationLabels, 100, 300),
      location,
    ]),
    scheduleValues: unique([
      ...asStringList(fields.recurrenceLabels, 100, 160),
      meetingTime,
    ]),
  };
};

const groupPromotionPlan = context => {
  const base = groupPromotionBasePlan(context);
  return {
    ...base,
    ...groupDuplicateAnalysis({
      candidate: context.candidate,
      title: base.title,
      locationValues: base.locationValues,
      scheduleValues: base.scheduleValues,
    }),
  };
};

const projectGroup = context => {
  const {
    candidate, source, sourceUrl, now, projectionLock, groupPlan,
  } = context;
  const fields = effectiveNormalizedFields(candidate);
  const { title, location, meetingTime } = groupPlan || groupPromotionPlan(context);

  const keyHash = sourceKeyHash(candidate.sourceItemKey);
  const publicSourceId = canonicalSourceId(candidate.sourceId, 'group', keyHash);
  const existing = Clubs.collection.findOne({ sourceId: publicSourceId });
  const canonicalId = existing?._id || canonicalMongoId(publicSourceId);
  const highest = Clubs.collection.findOne({}, { sort: { clubID: -1 }, fields: { clubID: 1 } });
  const clubID = existing?.clubID
    || Counters.nextId(`${Clubs.name}.clubID`, highest?.clubID || 0);

  renewProjectionLock(projectionLock);
  Clubs.collection.upsert({ _id: canonicalId }, {
    $set: {
      sourceId: publicSourceId,
      importedFrom: IMPORTED_FROM,
      name: title,
      owner: SYSTEM_ACTOR,
      description: supportDescription(fields),
      location,
      meetingTime,
      categories: ['support_group'],
      tags: [],
      publicationStatus: 'published',
      source: provenance(source, sourceUrl, fields.verifiedAt),
      updatedAt: now,
    },
    $setOnInsert: { clubID, createdAt: now },
  });
  const club = Clubs.collection.findOne(canonicalId);
  upsertSourceEntityKey({
    candidate,
    kind: 'group',
    keyHash,
    canonicalIds: [canonicalId],
    canonicalSourceIds: [publicSourceId],
    now,
    projectionLock,
  });
  reconcileGroupEvents(candidate.sourceId, keyHash, club, now, projectionLock);
  // The projection files the group under 'support_group' again whatever an
  // editor had since made of it, and may just have become the host of events
  // people are already going to. Memberships and those RSVPs are judged again
  // now, not at the next restart.
  syncFriendActivityForClub(canonicalId);

  return [{ kind: 'group', id: canonicalId, sourceId: publicSourceId }];
};

const parentGroupKeyHash = observation => {
  const groupKey = asText(observation.rawFields?.groupKey, 200);
  if (!groupKey || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(groupKey)) return undefined;
  return sourceKeyHash(`group:${groupKey}`);
};

const attendanceMode = fields => {
  const explicit = asText(fields.attendanceMode, 200)?.toLowerCase();
  if (['in_person', 'online', 'hybrid'].includes(explicit)) return explicit;
  if (explicit?.includes('mixed') || explicit?.includes('hybrid')) return 'hybrid';
  if (explicit?.includes('online')) return 'online';
  if (explicit?.includes('offline') || explicit?.includes('inperson')) return 'in_person';
  const location = asText(fields.location, 300)?.toLowerCase();
  const formats = asStringList(fields.formatLabels, 20, 80).join(' ').toLowerCase();
  const electronic = /online|virtual|zoom|electronic/.test(`${location || ''} ${formats}`);
  const inPerson = /in[ -]?person|physical/.test(formats) || (location && location !== 'online');
  if (electronic && inPerson) return 'hybrid';
  return electronic ? 'online' : 'in_person';
};

const projectEvent = context => {
  const {
    candidate, observation, source, sourceUrl, now, projectionLock, eventPlan,
  } = context;
  const fields = effectiveNormalizedFields(candidate);
  const {
    classification,
    isSupport,
    location,
    occurrences,
    recurrenceLabel,
    seriesKey,
    timeZone,
    title,
  } = eventPlan;
  const keyHash = sourceKeyHash(candidate.sourceItemKey);
  const parentKeyHash = isSupport ? parentGroupKeyHash(observation) : undefined;
  const parent = existingParentGroup(candidate.sourceId, parentKeyHash);
  const targets = occurrences.map(occurrence => {
    const localDate = moment.tz(occurrence.start, timeZone).format('YYYY-MM-DD');
    const occurrenceSuffix = recurrenceLabel ? localDate : undefined;
    const publicSourceId = canonicalSourceId(candidate.sourceId, 'event', keyHash, occurrenceSuffix);
    const existing = Events.collection.findOne({ sourceId: publicSourceId });
    const canonicalId = existing?._id || canonicalMongoId(publicSourceId);
    const reality = asText(fields.realityStatus, 40)?.toUpperCase();
    let cancellationStatus = 'scheduled';
    if (reality === 'CANCELLED') cancellationStatus = 'canceled';
    if (reality === 'POSTPONED') cancellationStatus = 'postponed';
    const unsetFields = {
      ...(!occurrence.end ? { endDate: '' } : {}),
      ...(!isSupport ? { description: '' } : {}),
    };

    renewProjectionLock(projectionLock);
    Events.collection.upsert({ _id: canonicalId }, {
      $set: {
        sourceId: publicSourceId,
        importedFrom: IMPORTED_FROM,
        eventID: parent?.clubID || 0,
        title,
        ...(isSupport ? { description: supportDescription(fields) } : {}),
        date: occurrence.start,
        location,
        createdBy: SYSTEM_ACTOR,
        owner: SYSTEM_ACTOR,
        hostName: parent?.name
          || asText(source.publisherName || source.displayName, 200)
          || title,
        categories: isSupport
          ? ['support_group']
          : unique([classification.topicKey, classification.subcategoryKey]),
        topicIds: [classification.topicKey],
        seriesId: seriesKey,
        timeZone,
        attendanceMode: attendanceMode(fields),
        publicationStatus: 'published',
        cancellationStatus,
        visibility: 'public',
        source: provenance(source, sourceUrl, fields.verifiedAt),
        updatedAt: now,
        ...(occurrence.end ? { endDate: occurrence.end } : {}),
      },
      $setOnInsert: { createdAt: now },
      ...(Object.keys(unsetFields).length ? { $unset: unsetFields } : {}),
    });
    const event = Events.collection.findOne(canonicalId);
    replaceSourceManagedEventLink(event, isSupport ? parent : null, now, projectionLock);
    // A re-review can move an event people are already going to under
    // 'support_group', or give it a support group for a host. Their RSVPs were
    // judged against the event as it was, and are judged again against this.
    syncFriendActivityForEvent(canonicalId);
    return { kind: 'event', id: canonicalId, sourceId: publicSourceId };
  });

  upsertSourceEntityKey({
    candidate,
    kind: 'event',
    keyHash,
    canonicalIds: targets.map(target => target.id),
    canonicalSourceIds: targets.map(target => target.sourceId),
    parentKeyHash,
    now,
    projectionLock,
  });
  return targets;
};

const existingDecisionResult = candidate => {
  const binding = editorialBindingFor(candidate);
  const decision = ReviewItems.findOne(approvalDecisionIdFor(candidate, binding));
  assertDurableEditorialBinding(candidate, decision, binding);
  const targets = decision?.canonicalTargets || candidate.canonicalTargets || [];
  if (decision && (decision.status !== 'APPROVED' || decision.publicationState !== 'COMPLETE')) {
    ReviewItems.update({
      _id: decision._id,
      editorialRevision: binding.editorialRevision,
      effectiveFieldsHash: binding.effectiveFieldsHash,
    }, {
      $set: { status: 'APPROVED', publicationState: 'COMPLETE', updatedAt: new Date() },
    });
  }
  return {
    candidateId: `${candidate._id}`,
    outcome: 'ALREADY_APPROVED',
    canonicalCount: targets.length,
    canonicalTargets: targets,
  };
};

const staleClaimSelector = staleAt => ({
  $or: [
    { approvalClaimedAt: { $lt: staleAt } },
    { approvalClaimedAt: { $exists: false } },
  ],
});

const assertFreshEditorialPreview = (candidate, reviewOptions) => {
  if (editorialRevisionFor(candidate) === 0) return;
  const expected = editorialPreviewTokenFor(candidate);
  const supplied = reviewOptions.editorialPreviewToken;
  const valid = typeof supplied === 'string'
    && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) {
    throw new Meteor.Error(
      'ingestion-editorial-preview-required',
      'Preview this edited candidate again before approving it.',
    );
  }
};

const assertClaimedEditorialBinding = (candidate, claim) => {
  const persisted = {
    editorialRevision: candidate?.approvalEditorialRevision,
    effectiveFieldsHash: candidate?.approvalEffectiveFieldsHash,
  };
  if (!candidate
      || candidate.approvalClaimToken !== claim.token
      || !sameEditorialBinding(persisted, claim.editorialBinding)
      || !sameEditorialBinding(editorialBindingFor(candidate), claim.editorialBinding)
      || candidate.approvalSourceValidationState
        !== claim.effectiveValidation.sourceValidationState
      || candidate.approvalEffectiveValidationState
        !== claim.effectiveValidation.effectiveValidationState
      || candidate.approvalEffectiveValidationBasis
        !== claim.effectiveValidation.effectiveValidationBasis) {
    throw new Meteor.Error(
      'ingestion-editorial-binding-mismatch',
      'The candidate changed after its reviewed editorial revision was claimed.',
    );
  }
};

const sameEffectiveValidation = (left, right) => (
  left?.sourceValidationState === right?.sourceValidationState
  && left?.effectiveValidationState === right?.effectiveValidationState
  && left?.effectiveValidationBasis === right?.effectiveValidationBasis
);

const assertDurableEffectiveValidation = (candidate, decision, effectiveValidation) => {
  const candidateValidation = {
    sourceValidationState: candidate.approvalSourceValidationState,
    effectiveValidationState: candidate.approvalEffectiveValidationState,
    effectiveValidationBasis: candidate.approvalEffectiveValidationBasis,
  };
  const decisionValidation = {
    sourceValidationState: decision?.sourceValidationState,
    effectiveValidationState: decision?.effectiveValidationState,
    effectiveValidationBasis: decision?.effectiveValidationBasis,
  };
  const candidateHasValidation = Boolean(candidateValidation.sourceValidationState);
  const decisionHasValidation = Boolean(decisionValidation.sourceValidationState);
  const requiresEvidence = editorialRevisionFor(candidate) > 0
    || effectiveValidation.sourceValidationState !== 'VALID';
  if ((candidateHasValidation
        && !sameEffectiveValidation(candidateValidation, effectiveValidation))
      || (decisionHasValidation
        && !sameEffectiveValidation(decisionValidation, effectiveValidation))
      || (requiresEvidence && (!candidateHasValidation || !decisionHasValidation))) {
    throw new Meteor.Error(
      'ingestion-effective-validation-mismatch',
      'The approved publication no longer matches its reviewed validation result.',
    );
  }
};

const editorialVersionClauses = candidate => [
  { fingerprint: candidate.fingerprint },
  candidate.editorialEditToken
    ? { editorialEditToken: candidate.editorialEditToken }
    : { editorialEditToken: { $exists: false } },
  editorialRevisionFor(candidate) === 0 ? {
    $or: [
      { editorialRevision: 0 },
      { editorialRevision: { $exists: false } },
    ],
  } : { editorialRevision: editorialRevisionFor(candidate) },
];

const validationStateSelectorFor = candidate => (
  candidate.validationState === undefined
    ? { validationState: { $exists: false } }
    : { validationState: candidate.validationState }
);

const claimCandidate = (context, userId, now) => {
  const { candidate, effectiveValidation, retryPublication } = context;
  const staleAt = new Date(now.getTime() - CLAIM_TTL_MS);
  const token = crypto.randomUUID();
  const binding = editorialBindingFor(candidate);
  const decisionId = retryPublication
    ? approvalDecisionIdFor(candidate, binding)
    : decisionIdFor(candidate._id, binding);
  if (retryPublication) {
    assertDurableEditorialBinding(
      candidate,
      ReviewItems.findOne(decisionId),
      binding,
    );
    assertDurableEffectiveValidation(
      candidate,
      ReviewItems.findOne(decisionId),
      effectiveValidation,
    );
  }
  const validationStateSelector = validationStateSelectorFor(candidate);
  const selector = retryPublication ? {
    _id: candidate._id,
    ...validationStateSelector,
    reviewStatus: 'APPROVED',
    $and: [
      {
        $or: [
          { publicationState: 'FAILED' },
          { publicationState: 'APPLYING', ...staleClaimSelector(staleAt) },
        ],
      },
      ...editorialVersionClauses(candidate),
    ],
  } : {
    _id: candidate._id,
    ...validationStateSelector,
    $and: [
      {
        $or: [
          {
            reviewStatus: 'PENDING',
            $or: [
              { approvalClaimToken: { $exists: false } },
              { approvalClaimedAt: { $lt: staleAt } },
              { approvalClaimedAt: { $exists: false } },
            ],
          },
          { reviewStatus: 'APPROVING', ...staleClaimSelector(staleAt) },
        ],
      },
      ...editorialVersionClauses(candidate),
    ],
  };
  const claimed = IngestionCandidates.update(selector, {
    $set: {
      ...(retryPublication ? { publicationState: 'APPLYING' } : { reviewStatus: 'APPROVING' }),
      approvalClaimToken: token,
      approvalClaimedAt: now,
      approvalClaimedBy: userId,
      approvalEditorialRevision: binding.editorialRevision,
      approvalEffectiveFieldsHash: binding.effectiveFieldsHash,
      approvalDecisionId: decisionId,
      approvalSourceValidationState: effectiveValidation.sourceValidationState,
      approvalEffectiveValidationState: effectiveValidation.effectiveValidationState,
      approvalEffectiveValidationBasis: effectiveValidation.effectiveValidationBasis,
    },
  });
  if (claimed !== 1) {
    const current = IngestionCandidates.findOne(candidate._id);
    if (publicationIsComplete(current || {})) return { alreadyApproved: true };
    throw new Meteor.Error(
      'ingestion-approval-in-progress',
      'Another review is already projecting this candidate.',
    );
  }
  return {
    token,
    alreadyApproved: false,
    retryPublication,
    editorialBinding: binding,
    decisionId,
    effectiveValidation,
  };
};

const releaseUnrecordedClaim = (candidateId, token, errorCode) => {
  IngestionCandidates.update({
    _id: candidateId,
    reviewStatus: 'APPROVING',
    approvalClaimToken: token,
  }, {
    $set: {
      reviewStatus: 'PENDING',
      lastProjectionErrorCode: `${errorCode || 'ingestion-projection-failed'}`.slice(0, 120),
    },
    $unset: {
      approvalClaimToken: '',
      approvalClaimedAt: '',
      approvalClaimedBy: '',
      approvalEditorialRevision: '',
      approvalEffectiveFieldsHash: '',
      approvalDecisionId: '',
      approvalSourceValidationState: '',
      approvalEffectiveValidationState: '',
      approvalEffectiveValidationBasis: '',
    },
  });
};

const recordApprovalDecision = (
  context,
  userId,
  at,
  publicationState,
  projectionReferenceAt,
  classification,
  duplicateOverrideUsed,
  duplicateReviewAcknowledged,
  automaticClassificationConfirmed,
  claim,
) => {
  const { decisionId, editorialBinding } = claim;
  const existing = ReviewItems.findOne(decisionId);
  if (existing?.decision && existing.decision !== 'APPROVE') {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'This candidate already has a conflicting review decision.',
    );
  }
  if (existing
      && Number.isInteger(existing.editorialRevision)
      && typeof existing.effectiveFieldsHash === 'string'
      && !sameEditorialBinding(existing, editorialBinding)) {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'This candidate already has an approval for a different editorial revision.',
    );
  }
  ReviewItems.upsert({ _id: decisionId }, {
    $set: {
      candidateId: `${context.candidate._id}`,
      candidateFingerprint: context.candidate.fingerprint || `${context.candidate._id}`,
      sourceId: context.candidate.sourceId,
      sourceItemKeyHash: sourceKeyHash(context.candidate.sourceItemKey),
      reviewLane: context.candidate.reviewLane || 'STANDARD',
      status: 'APPROVED',
      decision: 'APPROVE',
      reviewedBy: existing?.reviewedBy || userId,
      reviewedAt: existing?.reviewedAt || at,
      projectionVersion: PROJECTION_VERSION,
      publicationState,
      projectionReferenceAt,
      reviewSelection: {
        topicKey: classification.topicKey,
        subcategoryKey: classification.subcategoryKey,
      },
      classificationBasis: classification.basis,
      ...(classification.confidence !== undefined ? {
        classificationConfidence: classification.confidence,
      } : {}),
      duplicateOverrideUsed: duplicateOverrideUsed === true,
      duplicateReviewAcknowledged: duplicateReviewAcknowledged === true,
      automaticClassificationConfirmed: automaticClassificationConfirmed === true,
      editorialRevision: editorialBinding.editorialRevision,
      effectiveFieldsHash: editorialBinding.effectiveFieldsHash,
      publicationAttemptToken: claim.token,
      sourceValidationState: claim.effectiveValidation.sourceValidationState,
      effectiveValidationState: claim.effectiveValidation.effectiveValidationState,
      effectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
      updatedAt: at,
    },
    $setOnInsert: { createdAt: at, priority: 0 },
  });
  const recorded = ReviewItems.findOne(decisionId);
  if (recorded?.status !== 'APPROVED'
      || recorded?.decision !== 'APPROVE'
      || !sameEditorialBinding(recorded, editorialBinding)) {
    throw new Meteor.Error(
      'ingestion-review-decision-not-recorded',
      'The approval decision could not be durably recorded.',
    );
  }
  return decisionId;
};

const beginApprovedPublication = (
  context,
  claim,
  userId,
  at,
  projectionReferenceAt,
  classification,
  duplicateOverrideUsed,
  duplicateReviewAcknowledged,
  automaticClassificationConfirmed,
) => {
  const binding = claim.editorialBinding;
  if (!claim.retryPublication) {
    const started = IngestionCandidates.update({
      _id: context.candidate._id,
      ...validationStateSelectorFor(context.candidate),
      reviewStatus: 'APPROVING',
      approvalClaimToken: claim.token,
      approvalEditorialRevision: binding.editorialRevision,
      approvalEffectiveFieldsHash: binding.effectiveFieldsHash,
      approvalSourceValidationState: claim.effectiveValidation.sourceValidationState,
      approvalEffectiveValidationState: claim.effectiveValidation.effectiveValidationState,
      approvalEffectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
    }, {
      $set: {
        reviewStatus: 'APPROVED',
        reviewedAt: at,
        reviewedBy: userId,
        projectionVersion: PROJECTION_VERSION,
        publicationState: 'APPLYING',
        projectionReferenceAt,
        reviewSelection: {
          topicKey: classification.topicKey,
          subcategoryKey: classification.subcategoryKey,
        },
        classificationBasis: classification.basis,
        ...(classification.confidence !== undefined ? {
          classificationConfidence: classification.confidence,
        } : {}),
        duplicateOverrideUsed: duplicateOverrideUsed === true,
        duplicateReviewAcknowledged: duplicateReviewAcknowledged === true,
        automaticClassificationConfirmed: automaticClassificationConfirmed === true,
      },
      $unset: { lastProjectionErrorCode: '' },
    });
    if (started !== 1) {
      throw new Meteor.Error(
        'ingestion-candidate-state-changed',
        'The candidate changed while its approval decision was being recorded.',
      );
    }
  }

  const { decisionId } = claim;
  const decisionStarted = ReviewItems.update({
    _id: decisionId,
    editorialRevision: binding.editorialRevision,
    effectiveFieldsHash: binding.effectiveFieldsHash,
    publicationAttemptToken: claim.token,
    sourceValidationState: claim.effectiveValidation.sourceValidationState,
    effectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    effectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  }, {
    $set: { publicationState: 'APPLYING', updatedAt: at },
    $unset: { lastProjectionErrorCode: '' },
  });
  if (decisionStarted !== 1) {
    throw new Meteor.Error(
      'ingestion-approval-barrier-not-met',
      'The editorial revision was not durably bound to the approval decision.',
    );
  }

  const approvedCandidate = IngestionCandidates.findOne({
    _id: context.candidate._id,
    reviewStatus: 'APPROVED',
    publicationState: 'APPLYING',
    approvalClaimToken: claim.token,
    approvalEditorialRevision: binding.editorialRevision,
    approvalEffectiveFieldsHash: binding.effectiveFieldsHash,
    approvalSourceValidationState: claim.effectiveValidation.sourceValidationState,
    approvalEffectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    approvalEffectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  });
  const approvedDecision = ReviewItems.findOne({
    _id: decisionId,
    status: 'APPROVED',
    decision: 'APPROVE',
    editorialRevision: binding.editorialRevision,
    effectiveFieldsHash: binding.effectiveFieldsHash,
    publicationAttemptToken: claim.token,
    sourceValidationState: claim.effectiveValidation.sourceValidationState,
    effectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    effectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  });
  if (!approvedCandidate || !approvedDecision) {
    throw new Meteor.Error(
      'ingestion-approval-barrier-not-met',
      'Canonical publication is blocked until both approval records are durable.',
    );
  }
};

const markPublicationFailed = (context, claim, errorCode, at) => {
  const code = `${errorCode || 'ingestion-projection-failed'}`.slice(0, 120);
  const binding = claim.editorialBinding;
  const candidateFailed = IngestionCandidates.update({
    _id: context.candidate._id,
    approvalClaimToken: claim.token,
    approvalEditorialRevision: binding.editorialRevision,
    approvalEffectiveFieldsHash: binding.effectiveFieldsHash,
    approvalSourceValidationState: claim.effectiveValidation.sourceValidationState,
    approvalEffectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    approvalEffectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
    reviewStatus: { $in: ['APPROVING', 'APPROVED'] },
  }, {
    $set: {
      reviewStatus: 'APPROVED',
      publicationState: 'FAILED',
      reviewedAt: context.candidate.reviewedAt || at,
      reviewedBy: context.candidate.reviewedBy || claim.reviewedBy,
      lastProjectionErrorCode: code,
    },
    $unset: { approvalClaimToken: '', approvalClaimedAt: '', approvalClaimedBy: '' },
  });
  if (candidateFailed !== 1) return;
  ReviewItems.update({
    _id: claim.decisionId,
    editorialRevision: binding.editorialRevision,
    effectiveFieldsHash: binding.effectiveFieldsHash,
    publicationAttemptToken: claim.token,
    sourceValidationState: claim.effectiveValidation.sourceValidationState,
    effectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    effectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  }, {
    $set: { status: 'APPROVED', publicationState: 'FAILED', lastProjectionErrorCode: code, updatedAt: at },
  });
};

const completePublication = (context, claim, targets, at) => {
  const binding = claim.editorialBinding;
  const decisionCompleted = ReviewItems.update({
    _id: claim.decisionId,
    status: 'APPROVED',
    decision: 'APPROVE',
    publicationState: 'APPLYING',
    editorialRevision: binding.editorialRevision,
    effectiveFieldsHash: binding.effectiveFieldsHash,
    publicationAttemptToken: claim.token,
    sourceValidationState: claim.effectiveValidation.sourceValidationState,
    effectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    effectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  }, {
    $set: {
      status: 'APPROVED',
      publicationState: 'COMPLETE',
      canonicalTargets: targets,
      updatedAt: at,
    },
    $unset: { lastProjectionErrorCode: '' },
  });
  if (decisionCompleted !== 1) {
    throw new Meteor.Error(
      'ingestion-review-decision-not-recorded',
      'The completed publication could not be bound to its approval decision.',
    );
  }
  const completed = IngestionCandidates.update({
    _id: context.candidate._id,
    ...validationStateSelectorFor(context.candidate),
    reviewStatus: 'APPROVED',
    publicationState: 'APPLYING',
    approvalClaimToken: claim.token,
    approvalEditorialRevision: binding.editorialRevision,
    approvalEffectiveFieldsHash: binding.effectiveFieldsHash,
    approvalSourceValidationState: claim.effectiveValidation.sourceValidationState,
    approvalEffectiveValidationState: claim.effectiveValidation.effectiveValidationState,
    approvalEffectiveValidationBasis: claim.effectiveValidation.effectiveValidationBasis,
  }, {
    $set: {
      publicationState: 'COMPLETE',
      projectionVersion: PROJECTION_VERSION,
      canonicalTargets: targets,
    },
    $unset: {
      approvalClaimToken: '',
      approvalClaimedAt: '',
      approvalClaimedBy: '',
      lastProjectionErrorCode: '',
    },
  });
  if (completed !== 1) {
    throw new Meteor.Error(
      'ingestion-candidate-state-changed',
      'The approved publication claim changed before it could be completed.',
    );
  }
};

const sameSelection = (left, right) => (
  left?.topicKey === right?.topicKey && left?.subcategoryKey === right?.subcategoryKey
);

const sameOptionalSelection = (left, right) => (
  (!left && !right) || (Boolean(left) && Boolean(right) && sameSelection(left, right))
);

const optionsForDurableDecision = (context, requestedOptions) => {
  if (!context.retryPublication) return requestedOptions;
  const decision = ReviewItems.findOne(approvalDecisionIdFor(context.candidate));
  const storedSelection = decision?.reviewSelection || context.candidate.reviewSelection;
  if (requestedOptions.selection
      && storedSelection
      && !sameSelection(requestedOptions.selection, storedSelection)) {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'An interrupted publication must reuse its original reviewed classification.',
    );
  }
  if (requestedOptions.duplicateOverride
      && decision?.duplicateOverrideUsed !== true
      && context.candidate.duplicateOverrideUsed !== true) {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'An interrupted publication cannot add a duplicate override after approval.',
    );
  }
  if (requestedOptions.duplicateReviewAcknowledged
      && decision?.duplicateReviewAcknowledged !== true
      && context.candidate.duplicateReviewAcknowledged !== true) {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'An interrupted publication cannot add a duplicate acknowledgment after approval.',
    );
  }
  const selection = storedSelection || requestedOptions.selection;
  return {
    ...(selection ? { selection } : {}),
    duplicateOverride: decision?.duplicateOverrideUsed === true
      || context.candidate.duplicateOverrideUsed === true,
    duplicateReviewAcknowledged: decision?.duplicateReviewAcknowledged === true
      || context.candidate.duplicateReviewAcknowledged === true,
    confirmAutomaticClassifications: decision?.automaticClassificationConfirmed === true
      || context.candidate.automaticClassificationConfirmed === true,
  };
};

const duplicateErrorDetails = (duplicates, levels = ['BLOCK']) => JSON.stringify({
  matches: duplicates.filter(match => levels.includes(match.level)).map(match => ({
    ...match,
    ...(match.date instanceof Date ? { date: match.date.toISOString() } : {}),
  })),
});

const editorialSaveResult = candidate => ({
  candidateId: `${candidate._id}`,
  ...publicEditorialState(candidate),
  updatedAt: candidate.editorialUpdatedAt,
});

const assertEditableCandidate = candidate => {
  if (!candidate) {
    throw new Meteor.Error('ingestion-candidate-not-found', 'That intake candidate could not be found.');
  }
  assertLatestCandidateRevision(candidate);
  if (candidate.reviewStatus !== 'PENDING') {
    throw new Meteor.Error(
      'ingestion-candidate-edit-not-pending',
      'Only the latest pending candidate can be edited. Existing public records remain unchanged.',
    );
  }
};

const validateEditorialSchedule = (candidate, entityHint) => {
  const overrides = sanitizedEditorialOverrides(candidate);
  if (!overrides.schedule) return;
  const fields = effectiveNormalizedFields(candidate);
  const timeZone = asText(fields.timeZone, 100) || HAWAII_TIME_ZONE;
  if (timeZone !== HAWAII_TIME_ZONE) {
    throw new Meteor.Error(
      'ingestion-unsupported-time-zone',
      'Editorial schedules currently support only Pacific/Honolulu.',
    );
  }
  if (overrides.schedule.kind === 'ONE_TIME') {
    if (entityHint === 'group') {
      throw new Meteor.Error(
        'ingestion-invalid-editorial-overrides',
        'Community groups need a recurring schedule, not a one-time date.',
      );
    }
    oneTimeOccurrence(fields, timeZone);
    return;
  }
  if (!recurrenceParts(overrides.schedule.recurrenceLabel)) {
    throw new Meteor.Error(
      'ingestion-unsupported-recurrence',
      'Use a supported weekly or monthly recurrence label.',
    );
  }
};

const editorialAuditIdFor = (candidateId, expectedEditToken, patch) => (
  `editorial-override:${candidateId}:${hash([
    expectedEditToken,
    JSON.stringify(stableValue(patch)),
  ].join('|')).slice(0, 32)}`
);

const editorialAppliedAuditIdFor = intentId => `${intentId}:applied`;

const ensureEditorialIntent = ({
  candidate,
  intentId,
  userId,
  at,
  expectedEditToken,
  nextToken,
  nextRevision,
  nextOverrides,
  beforeBinding,
  afterBinding,
}) => {
  const expected = {
    decision: 'EDIT_CANDIDATE_INTENT',
    candidateId: `${candidate._id}`,
    candidateFingerprint: candidate.fingerprint || `${candidate._id}`,
    editorialRevisionBefore: beforeBinding.editorialRevision,
    editorialRevisionAfter: nextRevision,
    beforeEffectiveFieldsHash: beforeBinding.effectiveFieldsHash,
    afterEffectiveFieldsHash: afterBinding.effectiveFieldsHash,
    expectedEditTokenHash: hash(expectedEditToken),
    resultEditTokenHash: hash(nextToken),
  };
  const existing = ReviewItems.findOne(intentId);
  if (existing) {
    const compatible = Object.entries(expected).every(([key, value]) => existing[key] === value);
    if (!compatible || existing.status !== 'RECORDED') {
      throw new Meteor.Error(
        'ingestion-editorial-edit-conflict',
        'This editorial save request conflicts with its retained audit intent.',
      );
    }
    return existing;
  }
  ReviewItems.insert({
    _id: intentId,
    ...expected,
    sourceId: candidate.sourceId,
    sourceItemKeyHash: sourceKeyHash(candidate.sourceItemKey),
    reviewLane: candidate.reviewLane || 'STANDARD',
    status: 'RECORDED',
    editorialRevision: nextRevision,
    beforeEditorialOverrides: sanitizedEditorialOverrides(candidate),
    afterEditorialOverrides: nextOverrides,
    reviewedBy: userId,
    reviewedAt: at,
    createdAt: at,
    priority: 0,
  });
  return ReviewItems.findOne(intentId);
};

const ensureEditorialAppliedAudit = (candidate, intent, userId, at) => {
  const appliedId = editorialAppliedAuditIdFor(intent._id);
  const existing = ReviewItems.findOne(appliedId);
  if (existing) {
    if (existing.status !== 'COMPLETE'
        || existing.decision !== 'EDIT_CANDIDATE'
        || existing.intentId !== intent._id
        || existing.editorialRevision !== intent.editorialRevisionAfter
        || existing.effectiveFieldsHash !== intent.afterEffectiveFieldsHash) {
      throw new Meteor.Error(
        'ingestion-editorial-audit-finalize-failed',
        'The retained editorial audit outcome does not match this correction.',
      );
    }
    return existing;
  }
  ReviewItems.insert({
    _id: appliedId,
    intentId: intent._id,
    candidateId: intent.candidateId,
    candidateFingerprint: intent.candidateFingerprint,
    sourceId: intent.sourceId,
    sourceItemKeyHash: intent.sourceItemKeyHash,
    reviewLane: intent.reviewLane,
    status: 'COMPLETE',
    decision: 'EDIT_CANDIDATE',
    editorialRevision: intent.editorialRevisionAfter,
    effectiveFieldsHash: intent.afterEffectiveFieldsHash,
    reviewedBy: candidate.editorialUpdatedBy || userId,
    reviewedAt: candidate.editorialUpdatedAt || at,
    createdAt: at,
    priority: 0,
  });
  return ReviewItems.findOne(appliedId);
};

export const saveCandidateEditorialOverrides = (
  candidateId,
  userId,
  expectedEditToken,
  requestedOverrides,
  at = new Date(),
) => {
  requireAdmin(userId);
  if (typeof candidateId !== 'string' || !candidateId) {
    throw new Meteor.Error('ingestion-candidate-not-found', 'That intake candidate could not be found.');
  }
  if (typeof expectedEditToken !== 'string'
      || !expectedEditToken
      || expectedEditToken.length > 200) {
    throw new Meteor.Error(
      'ingestion-editorial-edit-conflict',
      'Refresh this candidate before saving editorial changes.',
    );
  }
  const patch = normalizeEditorialPatch(requestedOverrides);
  const initiallyRead = IngestionCandidates.findOne(candidateId);
  assertEditableCandidate(initiallyRead);

  let projectionLock;
  try {
    projectionLock = acquireProjectionLock(initiallyRead);
    const candidate = IngestionCandidates.findOne(candidateId);
    assertEditableCandidate(candidate);
    const intentId = editorialAuditIdFor(candidateId, expectedEditToken, patch);
    const existingIntent = ReviewItems.findOne(intentId);
    if (candidate.lastEditorialAuditId === intentId
        && existingIntent
        && existingIntent.editorialRevisionAfter === editorialRevisionFor(candidate)
        && existingIntent.afterEffectiveFieldsHash === effectiveFieldsHashFor(candidate)
        && existingIntent.resultEditTokenHash === hash(editorialEditTokenFor(candidate))) {
      ensureEditorialAppliedAudit(candidate, existingIntent, userId, at);
      return editorialSaveResult(candidate);
    }
    if (editorialEditTokenFor(candidate) !== expectedEditToken) {
      throw new Meteor.Error(
        'ingestion-editorial-edit-conflict',
        'This candidate changed after it was opened. Refresh before saving.',
      );
    }

    const nextOverrides = applyEditorialPatch(candidate, patch);
    const editedCandidate = { ...candidate, editorialOverrides: nextOverrides };
    const verified = verifiedCandidateData(editedCandidate, { enforcePublicationPolicy: false });
    validateEditorialSchedule(editedCandidate, verified.entityHint);
    const nextRevision = editorialRevisionFor(candidate) + 1;
    const nextToken = `edit:${hash([
      intentId,
      candidate.fingerprint,
      nextRevision,
    ].join('|')).slice(0, 48)}`;
    const beforeBinding = editorialBindingFor(candidate);
    const afterBinding = editorialBindingFor({
      ...editedCandidate,
      editorialRevision: nextRevision,
      editorialEditToken: nextToken,
    });
    const intent = ensureEditorialIntent({
      candidate,
      intentId,
      userId,
      at,
      expectedEditToken,
      nextToken,
      nextRevision,
      nextOverrides,
      beforeBinding,
      afterBinding,
    });

    const selector = {
      _id: candidate._id,
      fingerprint: candidate.fingerprint,
      reviewStatus: 'PENDING',
      ...(candidate.editorialEditToken
        ? { editorialEditToken: candidate.editorialEditToken }
        : { editorialEditToken: { $exists: false } }),
      ...(editorialRevisionFor(candidate) === 0 ? {
        $or: [
          { editorialRevision: 0 },
          { editorialRevision: { $exists: false } },
        ],
      } : { editorialRevision: editorialRevisionFor(candidate) }),
    };
    const setFields = {
      editorialRevision: nextRevision,
      editorialEditToken: nextToken,
      editorialUpdatedAt: at,
      editorialUpdatedBy: userId,
      lastEditorialAuditId: intentId,
      ...(Object.keys(nextOverrides).length ? { editorialOverrides: nextOverrides } : {}),
    };
    const updated = IngestionCandidates.update(selector, {
      $set: setFields,
      ...(Object.keys(nextOverrides).length ? {} : { $unset: { editorialOverrides: '' } }),
    });
    if (updated !== 1) {
      throw new Meteor.Error(
        'ingestion-editorial-edit-conflict',
        'This candidate changed while the editorial correction was saving.',
      );
    }
    const updatedCandidate = IngestionCandidates.findOne(candidateId);
    ensureEditorialAppliedAudit(updatedCandidate, intent, userId, at);
    return editorialSaveResult(updatedCandidate);
  } finally {
    releaseProjectionLock(projectionLock);
  }
};

export const approveCandidate = (
  candidateId,
  userId,
  at = new Date(),
  requestedOptions = {},
) => {
  requireAdmin(userId);
  const parsedOptions = normalizeReviewOptions(requestedOptions);
  const context = candidateContext(candidateId);
  if (context.alreadyApproved) return existingDecisionResult(context.candidate);
  if (!context.retryPublication) assertFreshEditorialPreview(context.candidate, parsedOptions);
  const reviewOptions = optionsForDurableDecision(context, parsedOptions);

  const claim = { ...claimCandidate(context, userId, at), reviewedBy: userId };
  if (claim.alreadyApproved) {
    return existingDecisionResult(IngestionCandidates.findOne(candidateId));
  }

  let decisionRecorded = claim.retryPublication;
  let activeContext = context;
  let projectionLock;
  let duplicateSlotLocks;
  try {
    projectionLock = acquireProjectionLock(context.candidate);
    const claimedCandidate = IngestionCandidates.findOne({
      _id: context.candidate._id,
      approvalClaimToken: claim.token,
    });
    assertClaimedEditorialBinding(claimedCandidate, claim);
    const claimedVerified = verifiedCandidateData(claimedCandidate);
    const claimedEffectiveValidation = effectiveApprovalValidation(
      claimedCandidate,
      claimedVerified.entityHint,
    );
    if (!sameEffectiveValidation(claimedEffectiveValidation, claim.effectiveValidation)) {
      throw new Meteor.Error(
        'ingestion-effective-validation-mismatch',
        'The candidate validation changed after its reviewed snapshot was claimed.',
      );
    }
    activeContext = {
      candidate: claimedCandidate,
      ...claimedVerified,
      effectiveValidation: claimedEffectiveValidation,
      alreadyApproved: false,
      retryPublication: context.retryPublication,
    };
    // A newer observation may arrive between the initial read and lock claim.
    // Recheck while this source item is serialized, before recording a decision.
    assertLatestCandidateRevision(activeContext.candidate);
    const projectionReferenceAt = claim.retryPublication
      ? (activeContext.candidate.projectionReferenceAt || activeContext.candidate.reviewedAt || at)
      : at;
    const eventBasePlan = activeContext.entityHint === 'event'
      ? eventPromotionBasePlan(activeContext, projectionReferenceAt, reviewOptions)
      : null;
    const groupBasePlan = activeContext.entityHint === 'group'
      ? groupPromotionBasePlan(activeContext)
      : null;
    const classification = eventBasePlan?.classification
      || effectiveClassification(activeContext.candidate, reviewOptions);
    assertClassificationAllowed(
      activeContext.candidate,
      classification,
    );
    if (eventBasePlan && !eventBasePlan.withinHorizon) {
      throw new Meteor.Error(
        'ingestion-event-outside-promotion-window',
        'Only upcoming events within the two-calendar-month review window can publish.',
      );
    }
    duplicateSlotLocks = acquireDuplicateSlotLocks(
      activeContext.candidate,
      eventBasePlan
        ? eventDuplicateSlotSeeds(eventBasePlan)
        : groupDuplicateSlotSeeds(groupBasePlan),
    );
    const eventPlan = eventBasePlan ? {
      ...eventBasePlan,
      ...duplicateAnalysis({
        candidate: activeContext.candidate,
        title: eventBasePlan.title,
        location: eventBasePlan.location,
        occurrences: eventBasePlan.occurrences,
      }),
    } : null;
    const groupPlan = groupBasePlan ? {
      ...groupBasePlan,
      ...groupDuplicateAnalysis({
        candidate: activeContext.candidate,
        title: groupBasePlan.title,
        locationValues: groupBasePlan.locationValues,
        scheduleValues: groupBasePlan.scheduleValues,
      }),
    } : null;
    const duplicatePlan = eventPlan || groupPlan;
    if (!claim.retryPublication
        && duplicatePlan?.duplicateLevel === 'BLOCK'
        && !reviewOptions.duplicateOverride) {
      throw new Meteor.Error(
        'ingestion-duplicate-event',
        'A near-exact current MatchBook listing must be resolved before this candidate can publish.',
        duplicateErrorDetails(duplicatePlan.duplicates),
      );
    }
    if (!claim.retryPublication
        && duplicatePlan?.duplicateLevel === 'REVIEW'
        && eventPlan?.occurrences.length > 1) {
      throw new Meteor.Error(
        'ingestion-recurring-duplicate-review-required',
        'A recurring template with a possible matching date must be resolved occurrence by occurrence.',
        duplicateErrorDetails(duplicatePlan.duplicates, ['REVIEW']),
      );
    }
    if (!claim.retryPublication
        && duplicatePlan?.duplicateLevel === 'REVIEW'
        && !reviewOptions.duplicateReviewAcknowledged) {
      throw new Meteor.Error(
        'ingestion-duplicate-review-required',
        'Review and explicitly acknowledge the possible matching listing before publication.',
        duplicateErrorDetails(duplicatePlan.duplicates, ['REVIEW']),
      );
    }
    recordApprovalDecision(
      activeContext,
      userId,
      at,
      claim.retryPublication ? 'APPLYING' : 'WAITING_FOR_CANDIDATE',
      projectionReferenceAt,
      classification,
      reviewOptions.duplicateOverride,
      reviewOptions.duplicateReviewAcknowledged,
      reviewOptions.confirmAutomaticClassifications,
      claim,
    );
    decisionRecorded = true;
    beginApprovedPublication(
      activeContext,
      claim,
      userId,
      at,
      projectionReferenceAt,
      classification,
      reviewOptions.duplicateOverride,
      reviewOptions.duplicateReviewAcknowledged,
      reviewOptions.confirmAutomaticClassifications,
    );

    const projectionContext = {
      ...activeContext,
      now: at,
      projectionReferenceAt,
      projectionLock,
      eventPlan,
      groupPlan,
    };
    renewDuplicateSlotLocks(duplicateSlotLocks);
    const targets = activeContext.entityHint === 'group'
      ? projectGroup(projectionContext)
      : projectEvent(projectionContext);
    renewProjectionLock(projectionLock);
    reopenReobservedApprovedCandidate(activeContext.candidate, projectionLock);
    completePublication(activeContext, claim, targets, at);
    return {
      candidateId: `${activeContext.candidate._id}`,
      outcome: claim.retryPublication ? 'PUBLICATION_REPAIRED' : 'APPROVED',
      canonicalCount: targets.length,
      canonicalTargets: targets,
      reviewSelection: {
        topicKey: classification.topicKey,
        subcategoryKey: classification.subcategoryKey,
      },
      duplicateOverrideUsed: reviewOptions.duplicateOverride,
      duplicateReviewAcknowledged: reviewOptions.duplicateReviewAcknowledged,
      automaticClassificationConfirmed: reviewOptions.confirmAutomaticClassifications,
    };
  } catch (error) {
    if (decisionRecorded) {
      markPublicationFailed(activeContext, claim, error.error || error.message, at);
    } else {
      releaseUnrecordedClaim(context.candidate._id, claim.token, error.error || error.message);
    }
    throw error;
  } finally {
    releaseDuplicateSlotLocks(duplicateSlotLocks);
    releaseProjectionLock(projectionLock);
  }
};

const resultCode = error => `${error?.error || error?.message || 'ingestion-projection-failed'}`.slice(0, 120);

const publicClassification = classification => ({
  topicKey: classification.topicKey,
  subcategoryKey: classification.subcategoryKey,
  ...(classification.confidence !== undefined ? { confidence: classification.confidence } : {}),
});

const previewFailure = (candidateId, error) => {
  const candidate = IngestionCandidates.findOne(candidateId);
  return {
    candidateId: `${candidateId}`,
    ...(candidate ? publicEditorialState(candidate) : {}),
    ...(candidate?.validationState ? { sourceValidationState: candidate.validationState } : {}),
    effectiveValidationState: 'INVALID',
    withinHorizon: false,
    bulkApprovalEligible: false,
    projectedOccurrenceCount: 0,
    duplicateReviewAcknowledgmentAllowed: false,
    duplicates: [],
    duplicateLevel: 'NONE',
    errorCode: resultCode(error),
  };
};

const previewCandidateAt = (candidateId, at, reviewOptions = {}) => {
  const candidate = IngestionCandidates.findOne(candidateId);
  if (!candidate) {
    throw new Meteor.Error('ingestion-candidate-not-found', 'That intake candidate could not be found.');
  }
  assertLatestCandidateRevision(candidate);
  const verified = verifiedCandidateData(candidate, { enforcePublicationPolicy: false });
  const context = { candidate, ...verified };
  const effectiveValidation = effectiveApprovalValidation(candidate, verified.entityHint);
  const classification = effectiveClassification(candidate, reviewOptions);
  const classificationRequiresReview = classification.basis === 'SERVER_FALLBACK'
    || (classification.basis === 'WORKER_SUGGESTION' && !hasBulkSafeSuggestion(candidate));
  const common = {
    candidateId: `${candidate._id}`,
    ...previewEditorialState(candidate),
    ...effectiveValidation,
    seriesKey: seriesKeyFor(context),
    effectiveClassification: publicClassification(classification),
    classificationRequiresReview,
    bulkApprovalEligible: hasBulkSafeSuggestion(candidate),
  };
  if (context.entityHint === 'group') {
    const fields = effectiveNormalizedFields(candidate);
    const plan = groupPromotionPlan(context);
    return {
      ...common,
      withinHorizon: true,
      bulkApprovalEligible: common.bulkApprovalEligible && plan.duplicateLevel === 'NONE',
      projectedOccurrenceCount: 1,
      duplicateReviewAcknowledgmentAllowed: true,
      duplicates: plan.duplicates,
      duplicateLevel: plan.duplicateLevel,
      publicProjection: {
        title: plan.title,
        location: plan.location,
        meetingTime: plan.meetingTime,
        description: supportDescription(fields),
        sourceUrl: context.sourceUrl,
        categories: ['support_group'],
        topicIds: ['support'],
      },
    };
  }
  const plan = eventPromotionPlan(context, at, reviewOptions);
  return {
    ...common,
    withinHorizon: plan.withinHorizon,
    bulkApprovalEligible: common.bulkApprovalEligible
      && plan.withinHorizon
      && plan.duplicateLevel === 'NONE',
    projectedOccurrenceCount: plan.occurrences.length,
    duplicateReviewAcknowledgmentAllowed: plan.occurrences.length <= 1,
    ...(plan.occurrences.length ? {
      projectedFirstDate: plan.occurrences[0].start,
      projectedLastDate: plan.occurrences[plan.occurrences.length - 1].start,
    } : {}),
    duplicates: plan.duplicates,
    duplicateLevel: plan.duplicateLevel,
    publicProjection: {
      title: plan.title,
      location: plan.location,
      description: plan.isSupport
        ? supportDescription(effectiveNormalizedFields(candidate))
        : null,
      sourceUrl: context.sourceUrl,
      categories: plan.isSupport
        ? ['support_group']
        : unique([classification.topicKey, classification.subcategoryKey]),
      topicIds: [classification.topicKey],
    },
  };
};

export const previewCandidates = (userId, requestedIds, at = new Date()) => {
  requireAdmin(userId);
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    throw new Meteor.Error(
      'ingestion-preview-empty',
      'Choose at least one candidate to preview.',
    );
  }
  const candidateIds = unique(requestedIds);
  if (candidateIds.length > MAX_PREVIEW_BATCH) {
    throw new Meteor.Error(
      'ingestion-preview-too-large',
      `Preview is limited to ${MAX_PREVIEW_BATCH} candidates at a time.`,
    );
  }
  return candidateIds.map(candidateId => {
    try {
      return previewCandidateAt(candidateId, at);
    } catch (error) {
      return previewFailure(candidateId, error);
    }
  });
};

const safeErrorDetails = error => {
  if (![
    'ingestion-duplicate-event',
    'ingestion-duplicate-review-required',
    'ingestion-recurring-duplicate-review-required',
  ].includes(error?.error)
      || typeof error.details !== 'string') return {};
  try {
    const parsed = JSON.parse(error.details);
    return Array.isArray(parsed.matches) ? { duplicates: parsed.matches } : {};
  } catch (parseError) {
    return {};
  }
};

export const approveCandidateBatch = (
  userId,
  requestedIds,
  requestedOptions = {},
  at = new Date(),
) => {
  requireAdmin(userId);
  const parsedOptions = normalizeReviewOptions(requestedOptions);
  const explicitIds = Array.isArray(requestedIds) ? unique(requestedIds).slice(0, MAX_BATCH) : null;
  const selector = explicitIds
    ? { _id: { $in: explicitIds } }
    : { validationState: 'VALID', reviewStatus: 'PENDING' };
  const candidates = IngestionCandidates.find(selector, {
    sort: { createdAt: 1, _id: 1 },
    limit: MAX_BATCH,
  }).fetch();
  const byId = new Map(candidates.map(candidate => [`${candidate._id}`, candidate]));
  const orderedIds = explicitIds || candidates.map(candidate => `${candidate._id}`);
  const sortable = orderedIds.map((candidateId, position) => {
    const candidate = byId.get(candidateId);
    const observation = candidate ? SourceObservations.findOne(candidate.observationId) : null;
    const kind = candidate?.entityHint || observation?.entityHint
      || (`${candidate?.sourceItemKey}`.startsWith('group:') ? 'group' : 'event');
    return { candidateId, kind, position };
  }).sort((left, right) => {
    const kindDifference = (left.kind === 'group' ? 0 : 1) - (right.kind === 'group' ? 0 : 1);
    return kindDifference || left.position - right.position;
  });

  // Count the real canonical impact before the first approval claim. A support
  // recurrence template is one review candidate but can project many Events.
  const preflightById = new Map();
  let projectedCanonicalRecords = 0;
  sortable.forEach(({ candidateId }) => {
    const candidate = byId.get(candidateId);
    if (!candidate || publicationIsComplete(candidate)) return;
    try {
      const preview = previewCandidateAt(candidateId, at, parsedOptions);
      preflightById.set(candidateId, { preview });
      if (preview.withinHorizon) {
        projectedCanonicalRecords += preview.projectedOccurrenceCount || 0;
      }
    } catch (error) {
      preflightById.set(candidateId, { error });
    }
  });
  if (projectedCanonicalRecords > MAX_BATCH_PROJECTED_RECORDS) {
    throw new Meteor.Error(
      'ingestion-batch-projection-too-large',
      `This approval would project ${projectedCanonicalRecords} records; the server limit is ${MAX_BATCH_PROJECTED_RECORDS}.`,
      JSON.stringify({ projectedCanonicalRecords, limit: MAX_BATCH_PROJECTED_RECORDS }),
    );
  }

  const breakdown = {
    requested: orderedIds.length,
    automaticClassificationsConfirmed: parsedOptions.confirmAutomaticClassifications,
    projectedCanonicalRecords,
    canonicalRecordsPublished: 0,
    attempted: 0,
    approved: 0,
    alreadyApproved: 0,
    blocked: 0,
    failed: 0,
    skipped: 0,
    results: [],
  };

  sortable.forEach(({ candidateId }) => {
    if (!byId.has(candidateId)) {
      breakdown.skipped += 1;
      breakdown.results.push({ candidateId, outcome: 'SKIPPED', code: 'ingestion-candidate-not-found' });
      return;
    }
    breakdown.attempted += 1;
    try {
      const candidate = byId.get(candidateId);
      if (candidate.reviewStatus === 'PENDING') {
        if (editorialRevisionFor(candidate) > 0) {
          throw new Meteor.Error(
            'ingestion-editorial-individual-review-required',
            'Edited candidates require a fresh individual preview and approval.',
          );
        }
        const preflight = preflightById.get(candidateId);
        if (preflight?.error) throw preflight.error;
        const preview = preflight?.preview || previewCandidateAt(candidateId, at, parsedOptions);
        const classification = effectiveClassification(candidate, parsedOptions);
        assertClassificationAllowed(
          candidate,
          classification,
        );
        if (!parsedOptions.selection && !hasBulkSafeSuggestion(candidate)) {
          throw new Meteor.Error(
            'ingestion-classification-review-required',
            'Bulk approval requires an explicitly reviewed or high-confidence source category.',
          );
        }
        if (!preview.withinHorizon) {
          throw new Meteor.Error(
            'ingestion-event-outside-promotion-window',
            'Only upcoming events within the two-calendar-month review window can publish.',
          );
        }
        if (preview.duplicateLevel === 'BLOCK') {
          throw new Meteor.Error(
            'ingestion-duplicate-event',
            'A near-exact current MatchBook listing must be resolved before this candidate can publish.',
            duplicateErrorDetails(preview.duplicates),
          );
        }
        if (preview.duplicateLevel === 'REVIEW') {
          if (preview.duplicateReviewAcknowledgmentAllowed === false) {
            throw new Meteor.Error(
              'ingestion-recurring-duplicate-review-required',
              'Recurring templates with possible matching dates require occurrence-level resolution.',
              duplicateErrorDetails(preview.duplicates, ['REVIEW']),
            );
          }
          throw new Meteor.Error(
            'ingestion-duplicate-review-required',
            'Possible matching listings must be reviewed one at a time before publication.',
            duplicateErrorDetails(preview.duplicates, ['REVIEW']),
          );
        }
      }
      const result = approveCandidate(candidateId, userId, at, requestedOptions);
      if (result.outcome === 'ALREADY_APPROVED') breakdown.alreadyApproved += 1;
      else breakdown.approved += 1;
      if (result.outcome !== 'ALREADY_APPROVED') {
        breakdown.canonicalRecordsPublished += result.canonicalCount || 0;
      }
      breakdown.results.push({
        candidateId,
        outcome: result.outcome,
        canonicalCount: result.canonicalCount,
      });
    } catch (error) {
      const code = resultCode(error);
      const blocked = BLOCKED_CODES.has(code);
      if (blocked) breakdown.blocked += 1;
      else breakdown.failed += 1;
      breakdown.results.push({
        candidateId,
        outcome: blocked ? 'BLOCKED' : 'FAILED',
        code,
        ...safeErrorDetails(error),
      });
    }
  });
  return breakdown;
};

export const approveCandidateSeries = (
  userId,
  requestedIds,
  requestedOptions = {},
  at = new Date(),
) => {
  requireAdmin(userId);
  const parsedOptions = normalizeReviewOptions(requestedOptions);
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    throw new Meteor.Error(
      'ingestion-series-empty',
      'Choose at least one candidate from the recurring series.',
    );
  }
  const requestedCandidateIds = unique(requestedIds);
  if (requestedCandidateIds.length > MAX_SERIES_BATCH) {
    throw new Meteor.Error(
      'ingestion-series-too-large',
      `Series approval is limited to ${MAX_SERIES_BATCH} candidates at a time.`,
    );
  }

  // This is intentionally recomputed from immutable candidate/observation
  // data; a client-supplied series label never defines the approval boundary.
  const requestedMemberships = requestedCandidateIds.map(seriesMembershipForCandidate);
  const seriesKeys = unique(requestedMemberships.map(membership => membership.seriesKey));
  if (seriesKeys.length !== 1) {
    throw new Meteor.Error(
      'ingestion-series-mismatch',
      'All candidates in one series approval must belong to the same source series.',
    );
  }
  const seriesKey = seriesKeys[0];
  const sourceId = requestedMemberships[0].candidate.sourceId;

  // Expand server-side so omitting a troublesome occurrence from the client
  // request cannot make an APPROVE_SERIES action silently partial.
  const sourceCandidates = IngestionCandidates.find({
    sourceId,
    reviewStatus: { $ne: 'SUPERSEDED' },
  }, {
    sort: { lastObservedAt: -1, createdAt: -1, _id: -1 },
    limit: 5001,
  }).fetch();
  if (sourceCandidates.length > 5000) {
    throw new Meteor.Error(
      'ingestion-series-source-too-large',
      'This source queue is too large to expand safely in one reviewed action.',
    );
  }
  const latestByItem = new Map();
  sourceCandidates.forEach(candidate => {
    if (!latestByItem.has(candidate.sourceItemKey)) {
      latestByItem.set(candidate.sourceItemKey, candidate);
    }
  });
  const actionableStatuses = new Set(['PENDING', 'APPROVING', 'APPROVED']);
  const seriesMembers = [...latestByItem.values()]
    .filter(candidate => actionableStatuses.has(candidate.reviewStatus))
    .map(candidate => seriesMembershipForCandidate(candidate._id))
    .filter(membership => membership.seriesKey === seriesKey)
    .map(membership => membership.candidate)
    .sort((left, right) => {
      const leftGroup = `${left.sourceItemKey}`.startsWith('group:') ? 0 : 1;
      const rightGroup = `${right.sourceItemKey}`.startsWith('group:') ? 0 : 1;
      const leftFields = effectiveNormalizedFields(left);
      const rightFields = effectiveNormalizedFields(right);
      return leftGroup - rightGroup
        || `${leftFields.localStart || ''}`.localeCompare(
          `${rightFields.localStart || ''}`,
        )
        || `${left._id}`.localeCompare(`${right._id}`);
    });
  if (seriesMembers.length > MAX_SERIES_BATCH) {
    throw new Meteor.Error(
      'ingestion-series-too-large',
      `Series approval is limited to ${MAX_SERIES_BATCH} candidates at a time.`,
    );
  }
  if (seriesMembers.some(candidate => editorialRevisionFor(candidate) > 0)) {
    throw new Meteor.Error(
      'ingestion-editorial-individual-review-required',
      'Edited candidates cannot be approved as a series; preview and approve each one individually.',
    );
  }
  const seriesMemberIds = seriesMembers.map(candidate => `${candidate._id}`);
  if (requestedCandidateIds.some(candidateId => !seriesMemberIds.includes(candidateId))) {
    throw new Meteor.Error(
      'ingestion-candidate-not-pending',
      'A selected series candidate is no longer actionable.',
    );
  }

  const previews = seriesMemberIds.map(candidateId => {
    try {
      return previewCandidateAt(candidateId, at, parsedOptions);
    } catch (error) {
      return { ...previewFailure(candidateId, error), seriesKey };
    }
  });
  const blockedPreviews = previews.filter(preview => preview.errorCode);
  const eligibleIds = previews
    .filter(preview => !preview.errorCode && preview.withinHorizon)
    .map(preview => preview.candidateId);
  const outsideIds = previews
    .filter(preview => !preview.errorCode && !preview.withinHorizon)
    .map(preview => preview.candidateId);
  const projectedCanonicalRecords = previews
    .filter(preview => !preview.errorCode && preview.withinHorizon)
    .reduce((total, preview) => total + (preview.projectedOccurrenceCount || 0), 0);
  if (eligibleIds.length === 0 && blockedPreviews.length === 0) {
    throw new Meteor.Error(
      'ingestion-series-outside-promotion-window',
      'This series has no upcoming candidates inside the two-calendar-month review window.',
    );
  }

  const firstCandidate = seriesMembers[0];
  const reviewActionId = `series-approval:${hash([
    sourceId,
    seriesKey,
    ...seriesMemberIds.slice().sort(),
  ].join('|')).slice(0, 40)}`;
  const existingAction = ReviewItems.findOne(reviewActionId);
  if (existingAction
      && (!sameOptionalSelection(existingAction.reviewSelection, parsedOptions.selection)
        || (existingAction.duplicateOverrideUsed === true) !== parsedOptions.duplicateOverride)) {
    throw new Meteor.Error(
      'ingestion-review-decision-conflict',
      'This series was already reviewed with a different classification or override decision.',
    );
  }
  ReviewItems.upsert({ _id: reviewActionId }, {
    $set: {
      sourceId: firstCandidate.sourceId,
      seriesKey,
      candidateIds: eligibleIds,
      excludedOutsideHorizonCandidateIds: outsideIds,
      blockedCandidateIds: blockedPreviews.map(preview => preview.candidateId),
      status: 'APPROVED',
      decision: 'APPROVE_SERIES',
      reviewedBy: existingAction?.reviewedBy || userId,
      reviewedAt: existingAction?.reviewedAt || at,
      publicationState: 'APPLYING',
      projectionVersion: PROJECTION_VERSION,
      projectedCanonicalRecords,
      ...(parsedOptions.selection ? { reviewSelection: parsedOptions.selection } : {}),
      duplicateOverrideUsed: parsedOptions.duplicateOverride,
      updatedAt: at,
    },
    $setOnInsert: { createdAt: at, priority: 0 },
  });

  const batch = eligibleIds.length
    ? approveCandidateBatch(userId, eligibleIds, requestedOptions, at)
    : {
      attempted: 0,
      projectedCanonicalRecords: 0,
      canonicalRecordsPublished: 0,
      approved: 0,
      alreadyApproved: 0,
      blocked: 0,
      failed: 0,
      skipped: 0,
      results: [],
    };
  const totalBlocked = batch.blocked + blockedPreviews.length;
  const publicationState = totalBlocked || batch.failed || batch.skipped ? 'PARTIAL' : 'COMPLETE';
  ReviewItems.update(reviewActionId, {
    $set: {
      publicationState,
      approvedCount: batch.approved,
      alreadyApprovedCount: batch.alreadyApproved,
      canonicalRecordsPublished: batch.canonicalRecordsPublished,
      blockedCount: totalBlocked,
      failedCount: batch.failed,
      updatedAt: at,
    },
  });

  return {
    reviewActionId,
    seriesKey,
    requested: requestedCandidateIds.length,
    seriesMembers: seriesMemberIds.length,
    eligible: eligibleIds.length,
    projectedCanonicalRecords,
    canonicalRecordsPublished: batch.canonicalRecordsPublished,
    outsideHorizon: outsideIds.length,
    attempted: batch.attempted,
    approved: batch.approved,
    alreadyApproved: batch.alreadyApproved,
    blocked: totalBlocked,
    failed: batch.failed,
    skipped: batch.skipped,
    publicationState,
    results: [
      ...batch.results,
      ...blockedPreviews.map(preview => ({
        candidateId: preview.candidateId,
        outcome: 'BLOCKED',
        code: preview.errorCode,
      })),
      ...outsideIds.map(candidateId => ({
        candidateId,
        outcome: 'EXCLUDED',
        code: 'ingestion-event-outside-promotion-window',
      })),
    ],
  };
};

Meteor.methods({
  [INGESTION_REVIEW_METHODS.approve](candidateId, reviewOptions = {}) {
    check(candidateId, String);
    check(reviewOptions, {
      topicKey: Match.Optional(String),
      subcategoryKey: Match.Optional(String),
      duplicateOverride: Match.Optional(Boolean),
      duplicateReviewAcknowledged: Match.Optional(Boolean),
      editorialPreviewToken: Match.Optional(String),
    });
    requireAdmin(this.userId);
    return approveCandidate(candidateId, this.userId, new Date(), reviewOptions);
  },

  [INGESTION_REVIEW_METHODS.approveAll](candidateIds = undefined, batchOptions = {}) {
    check(candidateIds, Match.Maybe([String]));
    check(batchOptions, { confirmAutomaticClassifications: Match.Optional(Boolean) });
    requireAdmin(this.userId);
    if (candidateIds && candidateIds.length > MAX_BATCH) {
      throw new Meteor.Error(
        'ingestion-batch-too-large',
        `Approve all is limited to ${MAX_BATCH} candidates at a time.`,
      );
    }
    return approveCandidateBatch(this.userId, candidateIds, batchOptions);
  },

  [INGESTION_REVIEW_METHODS.approveSeries](candidateIds, reviewOptions = {}) {
    check(candidateIds, [String]);
    check(reviewOptions, {
      topicKey: Match.Optional(String),
      subcategoryKey: Match.Optional(String),
    });
    requireAdmin(this.userId);
    return approveCandidateSeries(this.userId, candidateIds, reviewOptions);
  },

  [INGESTION_REVIEW_METHODS.clear](candidateIds, reason = 'REVIEWED_SKIP') {
    check(candidateIds, [String]);
    check(reason, String);
    requireAdmin(this.userId);
    return clearCandidatesFromReview(candidateIds, this.userId, reason);
  },

  [INGESTION_REVIEW_METHODS.preview](candidateIds) {
    check(candidateIds, [String]);
    requireAdmin(this.userId);
    return previewCandidates(this.userId, candidateIds);
  },

  [INGESTION_REVIEW_METHODS.reopen](candidateIds) {
    check(candidateIds, [String]);
    requireAdmin(this.userId);
    return reopenClearedCandidates(candidateIds, this.userId);
  },

  [INGESTION_REVIEW_METHODS.saveEditorialOverrides](
    candidateId,
    expectedEditToken,
    overrides,
  ) {
    check(candidateId, String);
    check(expectedEditToken, String);
    check(overrides, Object);
    requireAdmin(this.userId);
    return saveCandidateEditorialOverrides(
      candidateId,
      this.userId,
      expectedEditToken,
      overrides,
    );
  },
});

export const ensureIngestionReviewIndexes = async () => Promise.all([
  Clubs.collection.rawCollection().createIndex({ sourceId: 1 }, { unique: true, sparse: true }),
  Events.collection.rawCollection().createIndex({ sourceId: 1 }, { unique: true, sparse: true }),
  SourceEntityKeys.rawCollection().createIndex(
    { sourceId: 1, keyType: 1, keyHash: 1 },
    { unique: true },
  ),
  ReviewItems.rawCollection().createIndex({ candidateId: 1, decision: 1 }),
]);

Meteor.startup(() => {
  ensureIngestionReviewIndexes().catch(error => {
    console.error('[ingestion-review] index creation failed:', error.message);
  });
});
