import { Meteor } from 'meteor/meteor';
import { Roles } from 'meteor/alanning:roles';
import {
  CommunitySources,
  INGESTION_PUBLICATIONS,
  IngestionCandidates,
  SourceHealth,
  SourceRuns,
} from '../../api/ingestion/IngestionData';
import {
  ensureIngestionIndexes,
  SourcePolicyAssessments,
} from '../../api/ingestion/server/IngestionPersistence';

/* eslint-disable no-console */

const SOURCE_SEED_ASSET = 'community-sources.v1.json';
const CORE_SOURCE_IDS = new Set(
  Array.from({ length: 14 }, (_, index) => `SRC-${String(index + 1).padStart(3, '0')}`),
);
const SENSITIVE_SOURCE_IDS = new Set(
  Array.from({ length: 5 }, (_, index) => `SEN-${String(index + 1).padStart(3, '0')}`),
);
const REQUIRED_SOURCE_IDS = new Set([...CORE_SOURCE_IDS, ...SENSITIVE_SOURCE_IDS]);
const SECRET_QUERY_KEYS = new Set([
  'access_token',
  'api_key',
  'apikey',
  'key',
  'password',
  'secret',
  'token',
]);
const SECRET_HEADER_NAMES = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-api-key']);
const ADMIN_CANDIDATE_REVIEW_LIMIT = 5000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const requireString = (value, label) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
};

const requireDate = (value, label) => {
  const date = new Date(requireString(value, label));
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${label} must be an ISO date-time.`);
  }
  return date;
};

const validateEndpoint = (source, endpoint, index) => {
  if (!isRecord(endpoint)) throw new Error(`${source.id}.endpoints[${index}] must be an object.`);
  const template = requireString(endpoint.urlTemplate, `${source.id}.endpoints[${index}].urlTemplate`);
  let url;
  try {
    url = new URL(template.replace(/\{[^}]+\}/g, 'placeholder'));
  } catch (error) {
    throw new Error(`${source.id}.endpoints[${index}] must contain a valid URL.`);
  }

  if (url.protocol !== 'https:') throw new Error(`${source.id} endpoints must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${source.id} endpoint URLs must not contain credentials.`);

  const policy = source.httpPolicy;
  if (!isRecord(policy) || !Array.isArray(policy.allowedHosts) || policy.allowedHosts.length === 0
      || !Array.isArray(policy.allowedRedirectHosts)) {
    throw new Error(`${source.id}.httpPolicy must declare allowedHosts and allowedRedirectHosts.`);
  }
  const allowedHosts = new Set([...policy.allowedHosts, ...policy.allowedRedirectHosts].map(host => (
    requireString(host, `${source.id}.httpPolicy host`).toLowerCase()
  )));
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(`${source.id} endpoint host ${url.hostname} is not allowlisted.`);
  }

  url.searchParams.forEach((value, key) => {
    if (SECRET_QUERY_KEYS.has(key.toLowerCase())) {
      throw new Error(`${source.id} endpoint query must not contain ${key}.`);
    }
  });
  Object.keys(endpoint.headers || {}).forEach(header => {
    if (SECRET_HEADER_NAMES.has(header.toLowerCase())) {
      throw new Error(`${source.id} endpoint headers must not contain ${header}.`);
    }
  });
};

/**
 * Validate the safety properties the Meteor process depends on before writing
 * the registry. Full adapter validation belongs to the TypeScript worker; this
 * boundary refuses malformed, duplicate, or prematurely enabled seed data.
 */
const readSourceRegistry = () => {
  const registry = JSON.parse(Assets.getText(SOURCE_SEED_ASSET));
  if (!isRecord(registry) || !Array.isArray(registry.sources) || registry.sources.length === 0) {
    throw new Error('The community source registry must contain at least one source.');
  }

  const registryVersion = requireString(registry.registryVersion, 'registryVersion');
  const ids = new Set();
  const slugs = new Set();
  const sources = registry.sources.map((source, index) => {
    if (!isRecord(source)) throw new Error(`sources[${index}] must be an object.`);
    const id = requireString(source.id, `sources[${index}].id`);
    const slug = requireString(source.slug, `sources[${index}].slug`);
    requireString(source.displayName, `sources[${index}].displayName`);
    requireString(source.adapterKind, `sources[${index}].adapterKind`);
    requireString(source.steward, `sources[${index}].steward`);

    if (ids.has(id)) throw new Error(`Duplicate source id: ${id}`);
    if (slugs.has(slug)) throw new Error(`Duplicate source slug: ${slug}`);
    ids.add(id);
    slugs.add(slug);

    if (!isRecord(source.adapterConfig) || source.adapterConfig.kind !== source.adapterKind) {
      throw new Error(`${id} adapterConfig.kind must match adapterKind.`);
    }
    if (!Array.isArray(source.endpoints) || source.endpoints.length === 0) {
      throw new Error(`${id} must declare at least one endpoint.`);
    }
    source.endpoints.forEach((endpoint, endpointIndex) => validateEndpoint(source, endpoint, endpointIndex));
    // Enabling is a decision, recorded on the entry: the permission reached
    // AUTOMATED_ALLOWED, somebody put their name to it, and they said when.
    // The scaffold refused any enabled source at all, which kept every source
    // a probe for good; the rule now is that an enabled source has to have
    // been cleared, not that none may be.
    if (source.enabled !== false && source.enabled !== true) {
      throw new Error(`${id} enabled must be true or false.`);
    }
    if (source.enabled && source.permission !== 'AUTOMATED_ALLOWED') {
      throw new Error(`${id} may not be enabled until its permission is AUTOMATED_ALLOWED.`);
    }
    if (source.permission === 'AUTOMATED_ALLOWED'
        && (!source.steward || source.steward === 'unassigned' || !source.lastVerifiedAt)) {
      throw new Error(`${id} was cleared for automation without a steward and a verification date.`);
    }
    if (SENSITIVE_SOURCE_IDS.has(id)
        && (source.permission !== 'MANUAL_ONLY' || source.adapterKind !== 'MANUAL_CLIP')) {
      throw new Error(`${id} must remain a disabled MANUAL_ONLY sensitive-support source.`);
    }

    return {
      ...source,
      nextRunAt: requireDate(source.nextRunAt, `${id}.nextRunAt`),
      lastVerifiedAt: requireDate(source.lastVerifiedAt, `${id}.lastVerifiedAt`),
    };
  });

  if ([...REQUIRED_SOURCE_IDS].some(requiredId => !ids.has(requiredId))) {
    throw new Error('The community source registry is missing a required SRC-001..014 or SEN-001..005 source.');
  }
  if ([...ids].some(id => !/^(SRC|SEN)-\d{3}$/.test(id))) {
    throw new Error('Community source ids must use the SRC-### or SEN-### namespace.');
  }

  return { registryVersion, sources };
};

const seedSourceRegistry = async () => {
  const { registryVersion, sources } = readSourceRegistry();
  const loadedAt = new Date();
  const sourceOperations = sources.map(source => ({
    updateOne: {
      filter: { _id: source.id },
      update: {
        $set: {
          ...source,
          registryVersion,
          registryLoadedAt: loadedAt,
          ...(SENSITIVE_SOURCE_IDS.has(source.id) ? {
            reviewLane: 'SENSITIVE',
            privacyReviewRequired: true,
          } : {}),
        },
        $setOnInsert: { createdAt: loadedAt },
      },
      upsert: true,
    },
  }));
  const healthOperations = sources.map(source => ({
    updateOne: {
      filter: { sourceId: source.id },
      update: {
        $setOnInsert: {
          _id: source.id,
          sourceId: source.id,
          lastStatus: 'NOT_RUN',
          consecutiveFailures: 0,
          createdAt: loadedAt,
        },
      },
      upsert: true,
    },
  }));

  await CommunitySources.rawCollection().bulkWrite(sourceOperations, { ordered: true });
  await SourceHealth.rawCollection().bulkWrite(healthOperations, { ordered: true });

  const sensitivePolicyOperations = sources
    .filter(source => SENSITIVE_SOURCE_IDS.has(source.id))
    .map(source => ({
      updateOne: {
        filter: { sourceId: source.id, revision: 1 },
        update: {
          $set: {
            sourceId: source.id,
            revision: 1,
            classification: 'SENSITIVE_SUPPORT_SCHEDULE',
            reviewLane: 'SENSITIVE',
            policyVersion: 'sensitive-schedule.v1',
            policyStatus: source.id === 'SEN-005' ? 'PERMISSION_EVIDENCE_REQUIRED' : 'MANUAL_INTAKE_APPROVED',
            collectionDecision: 'MANUAL_ONLY',
            namedSteward: source.steward,
            namedPrivacyReviewer: 'MatchBook community register administrator',
            exactWordingFields: ['meetingTypeLabels', 'audienceEligibilityText'],
            prohibitedFields: [
              'participantIdentity',
              'personalContact',
              'privateAccessUrl',
              'meetingCredential',
              'healthInference',
            ],
            artifactMode: 'SANITIZED_STRUCTURED_SNAPSHOT_ONLY',
            evidenceExcerptMode: 'OMIT',
            publicProjectionRequiresHumanApproval: true,
            requiresKauaiScopeEvidence: source.id === 'SEN-005',
            assessedAt: loadedAt,
          },
          $setOnInsert: { _id: `${source.id}:1`, createdAt: loadedAt },
        },
        upsert: true,
      },
    }));
  if (sensitivePolicyOperations.length) {
    await SourcePolicyAssessments.rawCollection().bulkWrite(sensitivePolicyOperations, { ordered: true });
  }
  return sources.length;
};

const isAdmin = userId => Boolean(userId && Roles.userIsInRole(userId, 'admin'));

Meteor.publish(INGESTION_PUBLICATIONS.sources, function () {
  if (!isAdmin(this.userId)) return this.ready();
  return CommunitySources.find({}, {
    fields: {
      _id: 1,
      id: 1,
      sourceId: 1,
      displayName: 1,
      publisherName: 1,
      publisherUrl: 1,
      slug: 1,
      tier: 1,
      adapterKind: 1,
      permission: 1,
      enabled: 1,
      steward: 1,
      reviewLane: 1,
      privacyReviewRequired: 1,
      lastVerifiedAt: 1,
    },
    sort: { displayName: 1 },
  });
});

Meteor.publish(INGESTION_PUBLICATIONS.runs, function () {
  if (!isAdmin(this.userId)) return this.ready();
  return SourceRuns.find({}, {
    fields: {
      _id: 1,
      sourceId: 1,
      status: 1,
      completeness: 1,
      metrics: 1,
      startedAt: 1,
      finishedAt: 1,
      createdAt: 1,
      errorCode: 1,
    },
    sort: { startedAt: -1, createdAt: -1 },
    limit: 200,
  });
});

Meteor.publish(INGESTION_PUBLICATIONS.candidates, function () {
  if (!isAdmin(this.userId)) return this.ready();
  return IngestionCandidates.find({}, {
    fields: {
      _id: 1,
      sourceId: 1,
      sourceItemKey: 1,
      observationId: 1,
      entityHint: 1,
      parentSourceItemKey: 1,
      summary: 1,
      validationState: 1,
      reviewStatus: 1,
      reviewDispositionRevision: 1,
      clearedAt: 1,
      clearReason: 1,
      reviewLane: 1,
      privacyReviewRequired: 1,
      projectionEligibility: 1,
      classificationSuggestion: 1,
      recurringSeriesKey: 1,
      'normalizedFields.title': 1,
      'normalizedFields.localStart': 1,
      'normalizedFields.localEnd': 1,
      'normalizedFields.location': 1,
      'normalizedFields.locationLabels': 1,
      'normalizedFields.recurrenceLabel': 1,
      'normalizedFields.recurrenceLabels': 1,
      'normalizedFields.formatLabels': 1,
      'normalizedFields.supportSubtype': 1,
      'normalizedFields.sourceUrl': 1,
      'normalizedFields.reviewFlags': 1,
      'normalizedFields.timeZone': 1,
      'normalizedFields.listingType': 1,
      'normalizedFields.realityStatus': 1,
      'normalizedFields.reviewDescription': 1,
      'normalizedFields.context': 1,
      'normalizedFields.locationHint': 1,
      'normalizedFields.researchNeeded': 1,
      'normalizedFields.reviewContextVersion': 1,
      'editorialOverrides.title': 1,
      'editorialOverrides.location': 1,
      'editorialOverrides.schedule.kind': 1,
      'editorialOverrides.schedule.localStart': 1,
      'editorialOverrides.schedule.localEnd': 1,
      'editorialOverrides.schedule.recurrenceLabel': 1,
      editorialRevision: 1,
      editorialEditToken: 1,
      editorialUpdatedAt: 1,
      createdAt: 1,
      lastObservedAt: 1,
      reviewedAt: 1,
      approvalClaimedAt: 1,
      publicationState: 1,
      canonicalTargets: 1,
      lastProjectionErrorCode: 1,
    },
    sort: { createdAt: -1 },
    limit: ADMIN_CANDIDATE_REVIEW_LIMIT,
  });
});

Meteor.publish(INGESTION_PUBLICATIONS.health, function () {
  if (!isAdmin(this.userId)) return this.ready();
  return SourceHealth.find({}, {
    fields: {
      _id: 1,
      sourceId: 1,
      lastAttemptAt: 1,
      lastSuccessAt: 1,
      lastStatus: 1,
      lastErrorCode: 1,
      consecutiveFailures: 1,
    },
    sort: { sourceId: 1 },
  });
});

Meteor.startup(async () => {
  await ensureIngestionIndexes();
  const sourceCount = await seedSourceRegistry();
  console.log(`[ingestion] loaded ${sourceCount} source definitions.`);
});
