import { load } from 'cheerio';
import type { ExtractedItem, SourceDefinition } from './contracts.js';
import { sha256, stableHash } from './hash.js';

export const CANDIDATE_RESEARCH_CONTRACT_VERSION = 'candidate-research.v2';

export type ResearchStrategy =
  | 'RETAINED_EVIDENCE'
  | 'OFFICIAL_DETAIL'
  | 'REGISTERED_SOURCE_REFETCH'
  | 'WEB_SEARCH_PROVIDER';

export type ResearchAttempt = {
  strategy: ResearchStrategy;
  status: 'SUCCEEDED' | 'NO_MATCH' | 'UNAVAILABLE' | 'FAILED';
  code?: string;
  startedAt?: Date;
  finishedAt?: Date;
};

export type ResearchProgress = {
  stage: ResearchStrategy | 'COMPLETE';
  status: 'RUNNING' | 'COMPLETED';
  message: string;
  updatedAt: Date;
};

export type ResearchEvidence = {
  id: string;
  kind: ResearchStrategy;
  sourceUrl: string;
  observedAt: Date;
  contentHash: string;
  fields: string[];
  basisKey: string;
};

export type ResearchFieldSuggestion = {
  field: string;
  value: unknown;
  confidence: number;
  reason: string;
  evidenceIds: string[];
  basisKey: string;
};

export type CandidateResearchBasis = {
  candidateFingerprint: string;
  observationId: string;
  editorialRevision: number;
  basisKey: string;
};

export type CandidateForResearch = {
  id: string;
  sourceId: string;
  sourceItemKey: string;
  fingerprint: string;
  observationId: string;
  editorialRevision: number;
  entityHint: 'event' | 'group';
  normalizedFields: Record<string, unknown>;
  reviewLane?: 'SENSITIVE';
  privacyReviewRequired?: boolean;
  detailUrl?: string;
};

export type CandidateResearchRecord = {
  contractVersion: typeof CANDIDATE_RESEARCH_CONTRACT_VERSION;
  requestId: string;
  status: 'RUNNING' | 'SUCCEEDED' | 'PARTIAL' | 'UNAVAILABLE' | 'FAILED';
  basis: CandidateResearchBasis;
  missingFields: string[];
  attempts: ResearchAttempt[];
  evidence: ResearchEvidence[];
  fieldSuggestions: ResearchFieldSuggestion[];
  retryable: boolean;
  searchFallback: {
    availability: 'AVAILABLE' | 'UNAVAILABLE';
    mode: 'MANUAL_FOLLOW_UP';
    query: string;
    href: string;
    provider?: string;
  };
  startedAt: Date;
  finishedAt: Date;
  updatedAt: Date;
  errorCode?: string;
  queue?: {
    status: string;
    attemptCount: number;
    maxAttempts: number;
    availableAt?: Date;
    nextAttemptAt?: Date;
    leaseUntil?: Date;
    lastAttemptAt?: Date;
    lastErrorCode?: string;
    lastErrorAt?: Date;
    progressStage: string;
    progressMessage: string;
    updatedAt: Date;
  };
};

export type ResearchExtractResult = {
  items: ExtractedItem[];
  evidenceUrl: string;
  contentHash: string;
};

export type SearchResult = { url: string };

export interface ResearchSearchProvider {
  readonly name: string;
  search(query: string): Promise<SearchResult[]>;
}

type ExtractionStrategy = () => Promise<ResearchExtractResult>;

const BLOCKED_TEXT = /(zoom\.us|meet\.google\.com|teams\.microsoft\.com|\bpasscode\b|\bmeeting\s+id\b|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\D)(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}(?:\D|$)|(?:\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.)\S+)/i;
const CONTACT_IN_URL = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:^|\D)(?:\+?1[\s().-]*)?(?:\(?[2-9]\d{2}\)?[\s().-]*)?[2-9]\d{2}[\s.-]*\d{4}(?:\D|$)/i;
const SECRET_QUERY_NAMES = new Set([
  'access_token', 'api_key', 'key', 'password', 'passcode', 'pwd', 'secret', 'token',
]);
const PRIVATE_MEETING_HOSTS = [
  'zoom.us',
  'meet.google.com',
  'teams.microsoft.com',
  'webex.com',
];
const REDIRECT_HOSTS = new Set(['t.co', 'l.facebook.com', 'lm.facebook.com']);

const compactCode = (value: unknown, fallback: string): string => {
  if (!value || typeof value !== 'object' || !('code' in value)) return fallback;
  const code = (value as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,120}$/.test(code) ? code : fallback;
};

const hasValue = (value: unknown): boolean => {
  if (typeof value === 'string') return Boolean(value.trim());
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
};

const VENUE_CLUE = /\b(?:beach|church|chapel|temple|park|library|school|campus|center|centre|hall|clubhouse|theater|theatre|museum|garden|market|farm|resort|hotel|cafe|coffee|restaurant|arena|gym|studio|clinic|hospital)\b/i;
const STREET_OR_POSTAL_SIGNAL = /(?:\b\d{1,6}\s+\S|\b(?:967\d{2})\b|\b(?:street|road|avenue|highway|drive|lane|boulevard|place|way)\b)/i;
export const CURATOR_LOCATION_CONFIRMED_FIELD = '__matchbookCuratorLocationConfirmed';

const firstText = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;
  return value.find(item => typeof item === 'string' && item.trim())?.trim();
};

const locationValue = (fields: Record<string, unknown>): string | undefined => (
  firstText(fields.location) ?? firstText(fields.locationLabels)
);

/** A named public venue is useful, but still benefits from an address lookup. */
export const locationNeedsResolution = (value: unknown): boolean => {
  const text = firstText(value);
  return Boolean(text && VENUE_CLUE.test(text) && !STREET_OR_POSTAL_SIGNAL.test(text));
};

const locationSpecificity = (value: unknown): number => {
  const text = firstText(value);
  if (!text) return 0;
  return STREET_OR_POSTAL_SIGNAL.test(text)
    ? 100 + Math.min(text.split(/\s+/).length, 20) + Math.min((text.match(/,/g) || []).length * 5, 15)
    : 1;
};

export const candidateResearchBasisFor = (candidate: Pick<
CandidateForResearch,
'fingerprint' | 'observationId' | 'editorialRevision'
>): CandidateResearchBasis => ({
  candidateFingerprint: candidate.fingerprint,
  observationId: candidate.observationId,
  editorialRevision: candidate.editorialRevision,
  basisKey: sha256(`${candidate.fingerprint}\n${candidate.editorialRevision}`),
});

export const missingResearchFields = (
  entityHint: CandidateForResearch['entityHint'],
  fields: Record<string, unknown>,
): string[] => {
  const missing: string[] = [];
  if (!hasValue(fields.title)) missing.push('title');
  const location = locationValue(fields);
  if (!hasValue(location)
    || (fields[CURATOR_LOCATION_CONFIRMED_FIELD] !== true && locationNeedsResolution(location))) {
    missing.push('location');
  }
  const scheduleResearchRequested = Array.isArray(fields.researchNeeded)
    && fields.researchNeeded.includes('schedule');
  if (entityHint === 'group') {
    if (!hasValue(fields.recurrenceLabel) || scheduleResearchRequested) {
      missing.push('recurrenceLabel');
    }
  } else {
    const scheduleField = eventScheduleResearchField(fields, scheduleResearchRequested);
    if (scheduleField) missing.push(scheduleField);
  }
  return missing;
};

const dateTimestamp = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
};

const validEventEnd = (start: unknown, end: unknown): boolean => {
  const startAt = dateTimestamp(start);
  const endAt = dateTimestamp(end);
  if (startAt === undefined || endAt === undefined) return false;
  const duration = endAt - startAt;
  return duration > 0 && duration <= 24 * 60 * 60 * 1000;
};

const eventScheduleResearchField = (
  fields: Record<string, unknown>,
  scheduleResearchRequested = Array.isArray(fields.researchNeeded)
    && fields.researchNeeded.includes('schedule'),
): 'localStart' | 'localEnd' | 'recurrenceLabel' | undefined => {
  if (hasValue(fields.recurrenceLabel)) {
    return scheduleResearchRequested ? 'recurrenceLabel' : undefined;
  }
  if (dateTimestamp(fields.localStart) === undefined) return 'localStart';
  if (hasValue(fields.localEnd) && !validEventEnd(fields.localStart, fields.localEnd)) {
    return 'localEnd';
  }
  return scheduleResearchRequested ? 'localEnd' : undefined;
};

const hostileTextToPlainText = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const text = load(`<div>${value}</div>`)('div').text().replace(/\s+/g, ' ').trim().slice(0, maxLength);
  if (!text || BLOCKED_TEXT.test(text)) return undefined;
  return text;
};

const safeDateTime = (value: unknown): string | undefined => {
  const text = hostileTextToPlainText(value, 100);
  return text && !Number.isNaN(Date.parse(text)) ? text : undefined;
};

const safeSuggestedValue = (field: string, value: unknown): unknown => {
  if (field === 'title') return hostileTextToPlainText(value, 300);
  if (field === 'location') return hostileTextToPlainText(value, 500);
  if (field === 'localStart' || field === 'localEnd') return safeDateTime(value);
  if (field === 'recurrenceLabel') return hostileTextToPlainText(value, 300);
  return undefined;
};

const extractedFieldValue = (item: ExtractedItem, field: string): unknown => {
  const direct = item.normalizedFields[field];
  if (hasValue(direct)) return direct;
  if (field === 'location' && Array.isArray(item.normalizedFields.locationLabels)) {
    return item.normalizedFields.locationLabels.find(hasValue);
  }
  if (field === 'recurrenceLabel' && Array.isArray(item.normalizedFields.recurrenceLabels)) {
    return item.normalizedFields.recurrenceLabels.find(hasValue);
  }
  return direct;
};

const canonicalUrl = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    for (const name of url.searchParams.keys()) {
      if (SECRET_QUERY_NAMES.has(name.toLowerCase())) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
};

const evidenceUrl = (raw: unknown): string | undefined => {
  const safe = canonicalUrl(raw);
  if (!safe) return undefined;
  const url = new URL(safe);
  let decoded = safe;
  try {
    decoded = decodeURIComponent(safe);
  } catch {
    return undefined;
  }
  if (CONTACT_IN_URL.test(decoded)) return undefined;
  const host = url.hostname.toLowerCase();
  if (PRIVATE_MEETING_HOSTS.some(value => host === value || host.endsWith(`.${value}`))) return undefined;
  if (REDIRECT_HOSTS.has(host)) return undefined;
  if ((host === 'google.com' || host.endsWith('.google.com')) && url.pathname === '/url') return undefined;
  if ((host === 'facebook.com' || host.endsWith('.facebook.com')) && url.pathname === '/l.php') return undefined;
  return safe;
};

const normalizedTitle = (fields: Record<string, unknown>): string => (
  typeof fields.title === 'string' ? fields.title.trim().toLowerCase().replace(/\s+/g, ' ') : ''
);

const normalizedDay = (fields: Record<string, unknown>): string => {
  const value = fields.localStart;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return '';
  return value.slice(0, 10);
};

const matchingItem = (
  candidate: CandidateForResearch,
  items: ExtractedItem[],
  allowSingle: boolean,
): ExtractedItem | undefined => {
  const compatibleItems = items.filter(item => item.entityHint === candidate.entityHint);
  const byKey = compatibleItems.find(item => item.sourceItemKey === candidate.sourceItemKey);
  if (byKey) return byKey;
  const detail = canonicalUrl(candidate.detailUrl);
  const byUrl = detail
    ? compatibleItems.find(item => canonicalUrl(item.canonicalSourceUrl) === detail)
    : undefined;
  if (byUrl) return byUrl;
  const title = normalizedTitle(candidate.normalizedFields);
  const day = normalizedDay(candidate.normalizedFields);
  const byFacts = compatibleItems.filter(item => normalizedTitle(item.normalizedFields) === title
    && (!day || normalizedDay(item.normalizedFields) === day));
  if (byFacts.length === 1) return byFacts[0];
  return allowSingle && compatibleItems.length === 1 ? compatibleItems[0] : undefined;
};

const suggestionsFor = (options: {
  candidate: CandidateForResearch;
  item: ExtractedItem;
  workingFields: Record<string, unknown>;
  basis: CandidateResearchBasis;
  evidenceId: string;
  confidence: number;
  reason: string;
}): ResearchFieldSuggestion[] => {
  const wanted = ['title'].filter(field => !hasValue(options.workingFields[field]));
  const existingLocation = locationValue(options.workingFields);
  if (!hasValue(existingLocation)
    || (options.workingFields[CURATOR_LOCATION_CONFIRMED_FIELD] !== true
      && locationNeedsResolution(existingLocation))) wanted.push('location');
  const scheduleResearchRequested = Array.isArray(options.workingFields.researchNeeded)
    && options.workingFields.researchNeeded.includes('schedule');
  const scheduleFieldNeeded = options.candidate.entityHint === 'group'
    ? (!hasValue(options.workingFields.recurrenceLabel) || scheduleResearchRequested
      ? 'recurrenceLabel'
      : undefined)
    : eventScheduleResearchField(options.workingFields, scheduleResearchRequested);
  if (scheduleFieldNeeded && scheduleFieldNeeded !== 'localEnd') {
    const scheduleOrder = options.candidate.entityHint === 'event'
      ? [scheduleFieldNeeded, scheduleFieldNeeded === 'localStart' ? 'recurrenceLabel' : 'localStart']
      : ['recurrenceLabel'];
    const scheduleField = scheduleOrder.find(field => (
      hasValue(safeSuggestedValue(field, extractedFieldValue(options.item, field)))
    ));
    if (scheduleField) wanted.push(scheduleField);
  }
  const itemHasDatedSchedule = options.candidate.entityHint === 'event'
    && (hasValue(options.workingFields.localStart) || wanted.includes('localStart'));
  if (itemHasDatedSchedule
    && (scheduleFieldNeeded === 'localEnd' || !hasValue(options.workingFields.localEnd))) {
    wanted.push('localEnd');
  }
  return wanted.flatMap(field => {
  const value = safeSuggestedValue(field, extractedFieldValue(options.item, field));
  if (!hasValue(value)) return [];
  const effectiveStart = hasValue(options.workingFields.localStart)
    ? options.workingFields.localStart
    : safeSuggestedValue('localStart', extractedFieldValue(options.item, 'localStart'));
  if (field === 'localEnd' && !validEventEnd(effectiveStart, value)) return [];
  if (field === 'location'
    && hasValue(existingLocation)
    && locationSpecificity(value) <= locationSpecificity(existingLocation)) return [];
  return [{
    field,
    value,
    confidence: options.confidence,
    reason: options.reason,
    evidenceIds: [options.evidenceId],
    basisKey: options.basis.basisKey,
  }];
  });
};

const publicSearch = (candidate: CandidateForResearch, source: SourceDefinition): {
  query: string;
  href: string;
} => {
  const sensitive = candidate.reviewLane === 'SENSITIVE'
    || candidate.privacyReviewRequired
    || /^SEN-\d{3}$/.test(source.id);
  const title = sensitive ? undefined : hostileTextToPlainText(candidate.normalizedFields.title, 120);
  const publisher = hostileTextToPlainText(source.publisherName, 120)
    ?? hostileTextToPlainText(source.displayName, 120)
    ?? 'Kauai community source';
  const venueClue = sensitive ? undefined : locationValue(candidate.normalizedFields);
  const locationLookup = venueClue && locationNeedsResolution(venueClue)
    ? `${venueClue} street address`
    : undefined;
  const query = [title, locationLookup, publisher, 'Kauai official details']
    .filter(Boolean).join(' ').slice(0, 300);
  return {
    query,
    href: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
  };
};

const sourceUrlAllowed = (raw: unknown, source: SourceDefinition): string | undefined => {
  const safe = canonicalUrl(raw);
  if (!safe) return undefined;
  return source.httpPolicy.allowedHosts.includes(new URL(safe).hostname) ? safe : undefined;
};

export const runCandidateResearch = async (options: {
  requestId: string;
  candidate: CandidateForResearch;
  source: SourceDefinition;
  retainedEvidence?: ExtractionStrategy;
  officialDetail?: (url: string) => Promise<ResearchExtractResult>;
  registeredSourceRefetch?: ExtractionStrategy;
  searchProvider?: ResearchSearchProvider;
  onProgress?: (progress: ResearchProgress) => Promise<void> | void;
  now?: () => Date;
}): Promise<CandidateResearchRecord> => {
  const startedAt = (options.now ?? (() => new Date()))();
  const basis = candidateResearchBasisFor(options.candidate);
  const attempts: ResearchAttempt[] = [];
  const evidence: ResearchEvidence[] = [];
  const fieldSuggestions: ResearchFieldSuggestion[] = [];
  // Earlier strategies carry higher confidence. Applying each accepted
  // proposal to this private working view means later fallbacks can fill only
  // gaps; they can never overwrite or conflict with earlier evidence.
  const workingFields = { ...options.candidate.normalizedFields };
  const search = publicSearch(options.candidate, options.source);
  const sensitive = options.candidate.reviewLane === 'SENSITIVE'
    || options.candidate.privacyReviewRequired
    || /^SEN-\d{3}$/.test(options.source.id);
  const sourceAutomationAllowed = !sensitive
    && ['PROBE_REQUIRED', 'AUTOMATED_ALLOWED'].includes(options.source.permission);
  const progress = async (
    stage: ResearchProgress['stage'],
    status: ResearchProgress['status'],
    message: string,
  ) => options.onProgress?.({
    stage,
    status,
    message,
    updatedAt: (options.now ?? (() => new Date()))(),
  });

  const extract = async (
    strategy: Exclude<ResearchStrategy, 'WEB_SEARCH_PROVIDER'>,
    action: ExtractionStrategy | undefined,
    confidence: number,
    reason: string,
    allowSingle: boolean,
    unavailableCode: string,
  ): Promise<number> => {
    const attemptStartedAt = (options.now ?? (() => new Date()))();
    await progress(strategy, 'RUNNING', `Checking ${strategy.toLowerCase().replaceAll('_', ' ')}.`);
    if (!action) {
      const finishedAt = (options.now ?? (() => new Date()))();
      attempts.push({
        strategy, status: 'UNAVAILABLE', code: unavailableCode, startedAt: attemptStartedAt, finishedAt,
      });
      await progress(strategy, 'COMPLETED', `${strategy.toLowerCase().replaceAll('_', ' ')} is unavailable.`);
      return 0;
    }
    try {
      const result = await action();
      const item = matchingItem(options.candidate, result.items, allowSingle);
      const safeUrl = evidenceUrl(result.evidenceUrl);
      if (!item || !safeUrl) {
        const finishedAt = (options.now ?? (() => new Date()))();
        attempts.push({
          strategy,
          status: 'NO_MATCH',
          code: item ? 'UNSAFE_EVIDENCE_URL' : 'CANDIDATE_NOT_FOUND',
          startedAt: attemptStartedAt,
          finishedAt,
        });
        await progress(strategy, 'COMPLETED', 'No matching safe candidate details were found in this step.');
        return 0;
      }
      const provisionalId = stableHash({
        basisKey: basis.basisKey,
        observationId: basis.observationId,
        kind: strategy,
        sourceUrl: safeUrl,
        contentHash: result.contentHash,
      });
      const proposals = suggestionsFor({
        candidate: options.candidate,
        item,
        workingFields,
        basis,
        evidenceId: provisionalId,
        confidence,
        reason,
      });
      if (!proposals.length) {
        const finishedAt = (options.now ?? (() => new Date()))();
        attempts.push({
          strategy,
          status: 'NO_MATCH',
          code: 'NO_NEW_SAFE_FIELDS',
          startedAt: attemptStartedAt,
          finishedAt,
        });
        await progress(strategy, 'COMPLETED', 'This step did not add a safer or more complete field.');
        return 0;
      }
      const fields = proposals.map(proposal => proposal.field).sort();
      const record: ResearchEvidence = {
        id: provisionalId,
        kind: strategy,
        sourceUrl: safeUrl,
        observedAt: (options.now ?? (() => new Date()))(),
        contentHash: result.contentHash,
        fields,
        basisKey: basis.basisKey,
      };
      evidence.push(record);
      fieldSuggestions.push(...proposals);
      proposals.forEach(proposal => {
        workingFields[proposal.field] = proposal.value;
      });
      const finishedAt = (options.now ?? (() => new Date()))();
      attempts.push({ strategy, status: 'SUCCEEDED', startedAt: attemptStartedAt, finishedAt });
      await progress(strategy, 'COMPLETED', `Found ${proposals.length} curator-reviewable suggestion${proposals.length === 1 ? '' : 's'}.`);
      return proposals.length;
    } catch (error) {
      const finishedAt = (options.now ?? (() => new Date()))();
      attempts.push({
        strategy,
        status: 'FAILED',
        code: compactCode(error, `${strategy}_FAILED`),
        startedAt: attemptStartedAt,
        finishedAt,
      });
      await progress(strategy, 'COMPLETED', 'This step failed safely; the next allowed fallback will be tried.');
      return 0;
    }
  };

  await extract(
    'RETAINED_EVIDENCE',
    options.retainedEvidence,
    0.98,
    'Re-extracted from the immutable retained source evidence.',
    false,
    'RETAINED_EVIDENCE_UNAVAILABLE',
  );

  const unresolved = () => missingResearchFields(options.candidate.entityHint, workingFields);

  if (unresolved().length && !sourceAutomationAllowed) {
    const blockedCode = sensitive ? 'SENSITIVE_AUTOMATION_BLOCKED' : 'SOURCE_PERMISSION_BLOCKED';
    const blockedAt = (options.now ?? (() => new Date()))();
    attempts.push(
      {
        strategy: 'OFFICIAL_DETAIL', status: 'UNAVAILABLE', code: blockedCode, startedAt: blockedAt, finishedAt: blockedAt,
      },
      {
        strategy: 'REGISTERED_SOURCE_REFETCH', status: 'UNAVAILABLE', code: blockedCode, startedAt: blockedAt, finishedAt: blockedAt,
      },
      {
        strategy: 'WEB_SEARCH_PROVIDER',
        status: 'UNAVAILABLE',
        code: sensitive ? 'SENSITIVE_SEARCH_BLOCKED' : 'SOURCE_PERMISSION_BLOCKED',
        startedAt: blockedAt,
        finishedAt: blockedAt,
      },
    );
    await progress('OFFICIAL_DETAIL', 'COMPLETED', sensitive
      ? 'Sensitive-source policy permits retained evidence only.'
      : 'Source policy does not permit automated follow-up.');
  }

  if (unresolved().length && sourceAutomationAllowed) {
    const detailUrl = sourceUrlAllowed(options.candidate.detailUrl ?? options.source.publisherUrl, options.source);
    await extract(
      'OFFICIAL_DETAIL',
      detailUrl && options.officialDetail ? () => options.officialDetail?.(detailUrl) as Promise<ResearchExtractResult> : undefined,
      0.95,
      'Found on the registered source official detail page.',
      true,
      detailUrl ? 'OFFICIAL_DETAIL_FETCH_UNAVAILABLE' : 'OFFICIAL_DETAIL_URL_UNAVAILABLE',
    );
    if (unresolved().length) {
      await extract(
        'REGISTERED_SOURCE_REFETCH',
        options.registeredSourceRefetch,
        0.9,
        'Re-extracted from the registered source using its governed adapter.',
        false,
        'REGISTERED_SOURCE_REFETCH_UNAVAILABLE',
      );
    }

    if (unresolved().length) {
      const searchStartedAt = (options.now ?? (() => new Date()))();
      await progress('WEB_SEARCH_PROVIDER', 'RUNNING', 'Checking the configured safe search fallback.');
      if (!options.searchProvider) {
        attempts.push({
          strategy: 'WEB_SEARCH_PROVIDER',
          status: 'UNAVAILABLE',
          code: 'SEARCH_PROVIDER_NOT_CONFIGURED',
          startedAt: searchStartedAt,
          finishedAt: (options.now ?? (() => new Date()))(),
        });
        await progress('WEB_SEARCH_PROVIDER', 'COMPLETED', 'No automated search provider is configured; manual follow-up remains available.');
      } else {
        try {
          const results = await options.searchProvider.search(search.query);
          const safeResults = [...new Set(results.flatMap(result => {
            const url = evidenceUrl(result.url);
            return url ? [url] : [];
          }))].slice(0, 5);
          safeResults.forEach(url => {
            const contentHash = sha256(url);
            const id = stableHash({
              basisKey: basis.basisKey,
              observationId: basis.observationId,
              kind: 'WEB_SEARCH_PROVIDER',
              sourceUrl: url,
              contentHash,
            });
            evidence.push({
              id,
              kind: 'WEB_SEARCH_PROVIDER',
              sourceUrl: url,
              observedAt: (options.now ?? (() => new Date()))(),
              contentHash,
              fields: [],
              basisKey: basis.basisKey,
            });
          });
          attempts.push(safeResults.length
            ? {
              strategy: 'WEB_SEARCH_PROVIDER', status: 'SUCCEEDED', code: 'MANUAL_FOLLOW_UP_REQUIRED', startedAt: searchStartedAt, finishedAt: (options.now ?? (() => new Date()))(),
            }
            : {
              strategy: 'WEB_SEARCH_PROVIDER', status: 'NO_MATCH', code: 'NO_SAFE_SEARCH_RESULTS', startedAt: searchStartedAt, finishedAt: (options.now ?? (() => new Date()))(),
            });
          await progress('WEB_SEARCH_PROVIDER', 'COMPLETED', safeResults.length
            ? 'Found safe public leads for manual curator follow-up.'
            : 'No safe public search leads were found.');
        } catch (error) {
          attempts.push({
            strategy: 'WEB_SEARCH_PROVIDER',
            status: 'FAILED',
            code: compactCode(error, 'SEARCH_PROVIDER_FAILED'),
            startedAt: searchStartedAt,
            finishedAt: (options.now ?? (() => new Date()))(),
          });
          await progress('WEB_SEARCH_PROVIDER', 'COMPLETED', 'The search provider failed safely; this request can be retried.');
        }
      }
    }
  }

  const finishedAt = (options.now ?? (() => new Date()))();
  const remainingMissingFields = unresolved();
  const status = remainingMissingFields.length === 0 ? 'SUCCEEDED'
    : fieldSuggestions.length || evidence.some(item => item.kind === 'WEB_SEARCH_PROVIDER') ? 'PARTIAL'
      : 'UNAVAILABLE';
  const retryable = remainingMissingFields.length > 0 && attempts.some(attempt => (
    attempt.status === 'FAILED'
    || attempt.code === 'SEARCH_PROVIDER_NOT_CONFIGURED'
  ));
  const lastFailedAttempt = [...attempts].reverse().find(attempt => attempt.status === 'FAILED');
  await progress('COMPLETE', 'COMPLETED', remainingMissingFields.length
    ? 'Research finished with unresolved fields for curator review.'
    : 'Research finished with suggestions for every missing field.');
  return {
    contractVersion: CANDIDATE_RESEARCH_CONTRACT_VERSION,
    requestId: options.requestId,
    status,
    basis,
    missingFields: remainingMissingFields,
    attempts,
    evidence,
    fieldSuggestions,
    retryable,
    searchFallback: {
      // The browser link is a real, human-operated fallback even when there is
      // no API provider. Sensitive sources remain excluded from broad search.
      availability: sensitive ? 'UNAVAILABLE' : 'AVAILABLE',
      mode: 'MANUAL_FOLLOW_UP',
      query: search.query,
      href: search.href,
      ...(options.searchProvider && sourceAutomationAllowed ? { provider: options.searchProvider.name } : {}),
    },
    startedAt,
    finishedAt,
    updatedAt: finishedAt,
    ...(lastFailedAttempt?.code ? { errorCode: lastFailedAttempt.code } : {}),
  };
};

const readBoundedJson = async (response: Response, limit: number): Promise<unknown> => {
  const announced = Number(response.headers.get('content-length'));
  if (Number.isFinite(announced) && announced > limit) {
    await response.body?.cancel('search response exceeds byte limit').catch(() => {});
    throw Object.assign(new Error('Search response is too large'), { code: 'SEARCH_RESPONSE_TOO_LARGE' });
  }
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel('search response exceeds byte limit').catch(() => {});
      throw Object.assign(new Error('Search response is too large'), { code: 'SEARCH_RESPONSE_TOO_LARGE' });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  chunks.forEach(chunk => {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
};

export class BraveResearchSearchProvider implements ResearchSearchProvider {
  readonly name = 'BRAVE';
  private readonly apiKey: string;
  private readonly transport: typeof fetch;

  constructor(apiKey: string, transport: typeof fetch = fetch) {
    if (!apiKey.trim()) throw new Error('Brave Search API key is required');
    this.apiKey = apiKey;
    this.transport = transport;
  }

  async search(query: string): Promise<SearchResult[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query.slice(0, 300));
    url.searchParams.set('count', '5');
    url.searchParams.set('safesearch', 'strict');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.transport(url.toString(), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
        redirect: 'error',
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel('search response rejected').catch(() => {});
        throw Object.assign(new Error('Search provider rejected the request'), { code: 'SEARCH_PROVIDER_REJECTED' });
      }
      const document = await readBoundedJson(response, 1_000_000);
      if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
      const web = (document as Record<string, unknown>).web;
      if (!web || typeof web !== 'object' || Array.isArray(web)) return [];
      const results = (web as Record<string, unknown>).results;
      if (!Array.isArray(results)) return [];
      return results.flatMap(result => {
        if (!result || typeof result !== 'object' || Array.isArray(result)) return [];
        const urlValue = (result as Record<string, unknown>).url;
        return typeof urlValue === 'string' ? [{ url: urlValue }] : [];
      }).slice(0, 5);
    } catch (error) {
      if (controller.signal.aborted) {
        throw Object.assign(new Error('Search provider timed out'), { code: 'SEARCH_PROVIDER_TIMEOUT' });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const researchSearchProviderFromEnvironment = (
  environment: NodeJS.ProcessEnv = process.env,
): ResearchSearchProvider | undefined => {
  if (environment.MATCHBOOK_RESEARCH_SEARCH_PROVIDER !== 'BRAVE') return undefined;
  const apiKey = environment.MATCHBOOK_RESEARCH_BRAVE_API_KEY;
  return apiKey?.trim() ? new BraveResearchSearchProvider(apiKey) : undefined;
};
