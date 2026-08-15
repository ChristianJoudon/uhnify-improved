import React, {
  useEffect,
  useMemo,
  useState,
} from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Container } from 'react-bootstrap';
import moment from 'moment-timezone';
import {
  ArrowLeft,
  ArrowRepeat,
  Check2All,
  CheckCircle,
  ExclamationTriangle,
  Inbox,
  PencilSquare,
  Save,
  Search,
  ShieldLock,
  X,
} from 'react-bootstrap-icons';
import { Link } from 'react-router-dom';
import swal from 'sweetalert';
import {
  CommunitySources,
  INGESTION_PUBLICATIONS,
  IngestionCandidates,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_RESEARCH_PUBLICATION,
  INGESTION_WORKER_HEALTH_PUBLICATION,
  IngestionWorkerHealth,
} from '../../api/ingestion/IngestionResearch';
import {
  INGESTION_REVIEW_TAXONOMY,
  INGESTION_TOPIC_KEYS,
  subcategoryOptionsFor,
} from '../../api/ingestion/IngestionReviewTaxonomy';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import {
  buildReviewUnits,
  candidateStart,
  candidateWithinReviewWindow,
  currentResearchFor,
  duplicateLevelForUnit,
  effectiveClassificationForUnit,
  effectiveReviewFields,
  previewCandidateIdsForUnit,
  previewForCandidate,
  previewRequestBasisFor,
  pendingReviewQueueSummary,
  projectionSummaryForUnit,
  REVIEW_HORIZON_MONTHS,
} from './EventReviewModel';
import './EventIntake.css';

const REVIEW_METHODS = Object.freeze({
  approve: 'ingestion.candidates.approve',
  approveAll: 'ingestion.candidates.approveAll',
  approveSeries: 'ingestion.candidates.approveSeries',
  clear: 'ingestion.candidates.clear',
  preview: 'ingestion.candidates.preview',
  reopen: 'ingestion.candidates.reopen',
  requestResearch: 'ingestion.research.request',
  saveEditorialOverrides: 'ingestion.candidates.saveEditorialOverrides',
});
const APPROVAL_CLAIM_TTL_MS = 5 * 60 * 1000;
const MAX_BULK_CANDIDATES = 500;
const MAX_BULK_PROJECTED_RECORDS = 1000;
const EDITABLE_RESEARCH_FIELDS = new Set([
  'title',
  'location',
  'localStart',
  'localEnd',
  'recurrenceLabel',
]);

const TOKEN_LABELS = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  PUBLISHED: 'Published',
  PUBLICATION_APPLYING: 'Publishing',
  PUBLICATION_FAILED: 'Publication needs retry',
  SUPERSEDED: 'Superseded',
  REJECTED: 'Cleared / skipped',
  VALID: 'Checks passed',
  INVALID: 'Needs attention',
  SUPPORT_GROUP: 'Support group',
  ADDICTION_RECOVERY: 'Addiction recovery',
  FAMILY_ADDICTION_SUPPORT: 'Family addiction support',
  MENTAL_HEALTH_PEER: 'Mental health peer support',
  MENTAL_HEALTH_FAMILY: 'Mental health family support',
  DEMENTIA_CAREGIVER: 'Dementia caregiver support',
  QUEUED: 'Research queued',
  RUNNING: 'Researching',
  SUCCEEDED: 'Details found',
  PARTIAL: 'Some details found',
  UNAVAILABLE: 'No safe details found',
  FAILED: 'Research needs retry',
  TITLE: 'Title',
  LOCATION: 'Location',
  LOCALSTART: 'Start time',
  LOCALEND: 'End time',
  RECURRENCELABEL: 'Repeat schedule',
};

const SAFE_REVIEW_CONTEXT_VERSION = 'safe-review.v1';
const CLASSIFICATION_REASON_LABELS = Object.freeze({
  EXPLICIT_SUPPORT_TYPE: 'The source explicitly identifies a support group',
  SOURCE_CATEGORY_MATCH: 'The source category matched',
  TITLE_MATCH: 'The title matched',
  DESCRIPTION_MATCH: 'The source description matched',
  CONTEXT_MATCH: 'The surrounding source context matched',
  SOURCE_PROFILE_MATCH: 'This source usually publishes this kind of listing',
  FALLBACK_COMMUNITY: 'No strong signal was found; Community is a fallback',
});

const humanizeToken = value => {
  if (!value) return 'Not recorded';
  const normalized = String(value).toUpperCase();
  if (TOKEN_LABELS[normalized]) return TOKEN_LABELS[normalized];
  const words = String(value).replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const safeReviewContextFor = candidate => {
  const fields = candidate?.normalizedFields || {};
  if (fields.reviewContextVersion !== SAFE_REVIEW_CONTEXT_VERSION) return null;
  const researchNeeded = Array.isArray(fields.researchNeeded)
    ? fields.researchNeeded.filter(value => typeof value === 'string' && value.trim())
    : [];
  return {
    description: typeof fields.reviewDescription === 'string'
      ? fields.reviewDescription.trim()
      : '',
    context: typeof fields.context === 'string' ? fields.context.trim() : '',
    locationHint: typeof fields.locationHint === 'string' ? fields.locationHint.trim() : '',
    researchNeeded,
  };
};

const classificationReasonsFor = candidate => (
  Array.isArray(candidate?.classificationSuggestion?.reasons)
    ? candidate.classificationSuggestion.reasons.map(reason => (
      CLASSIFICATION_REASON_LABELS[reason] || humanizeToken(reason)
    ))
    : []
);

const documentKey = document => String(document?.sourceId || document?.id || document?._id || 'unknown');
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value || {}, key);

const sourceName = source => source?.displayName || source?.publisherName || source?.slug || documentKey(source);

const safeReviewSourceUrl = (candidate, source) => {
  const publisherUrl = source?.publisherUrl;
  if (!publisherUrl) return null;
  try {
    const publisher = new URL(publisherUrl);
    const proposed = new URL(candidate.normalizedFields?.sourceUrl || publisherUrl);
    const publisherHost = publisher.hostname.replace(/^www\./, '');
    const proposedHost = proposed.hostname.replace(/^www\./, '');
    if (publisher.protocol !== 'https:'
        || proposed.protocol !== 'https:'
        || proposed.username
        || proposed.password
        || proposedHost !== publisherHost) return publisher.toString();
    return proposed.toString();
  } catch {
    return null;
  }
};

const safeExternalResearchUrl = value => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
};

const candidateKind = candidate => {
  if (candidate.entityHint === 'group' || candidate.entityHint === 'event') return candidate.entityHint;
  if (String(candidate.sourceItemKey || '').startsWith('group:')) return 'group';
  if (String(candidate.sourceItemKey || '').startsWith('event:')) return 'event';
  return 'candidate';
};

const candidateTitle = candidate => {
  const fields = effectiveReviewFields(candidate);
  if (hasOwn(candidate.editorialOverrides, 'title')) {
    return fields.title || 'Untitled intake candidate';
  }
  return fields.title
    || candidate.summary?.title
    || (typeof candidate.summary === 'string' ? candidate.summary : null)
    || 'Untitled intake candidate';
};

const formatDateTime = value => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'Pacific/Honolulu',
    timeZoneName: 'short',
  }).format(date);
};

const listText = value => (
  Array.isArray(value) && value.length ? value.join('; ') : null
);

const candidateSchedule = candidate => {
  const fields = effectiveReviewFields(candidate);
  if (fields.localStart) return formatDateTime(fields.localStart);
  if (fields.recurrenceLabel) return fields.recurrenceLabel;
  return listText(fields.recurrenceLabels) || candidate.summary?.when || null;
};

const candidateLocation = candidate => {
  const fields = effectiveReviewFields(candidate);
  if (hasOwn(candidate.editorialOverrides, 'location')) return fields.location || null;
  return fields.location || listText(fields.locationLabels) || candidate.summary?.location || null;
};

const editorDateTime = value => {
  if (!value) return '';
  const parsed = /[zZ]|[+-]\d{2}:?\d{2}$/.test(String(value))
    ? moment.parseZone(value).tz('Pacific/Honolulu')
    : moment.tz(value, 'Pacific/Honolulu');
  return parsed.isValid() ? parsed.format('YYYY-MM-DDTHH:mm') : '';
};

const editorialDraftFor = candidate => {
  const fields = effectiveReviewFields(candidate);
  const recurrenceLabel = fields.recurrenceLabel || listText(fields.recurrenceLabels);
  let scheduleKind = 'NONE';
  if (recurrenceLabel) scheduleKind = 'RECURRENCE';
  else if (fields.localStart) scheduleKind = 'ONE_TIME';
  else if (candidateKind(candidate) === 'group') scheduleKind = 'RECURRENCE';
  return {
    title: fields.title || '',
    location: candidateLocation(candidate) || '',
    scheduleKind,
    localStart: editorDateTime(fields.localStart),
    localEnd: editorDateTime(fields.localEnd),
    recurrenceLabel: recurrenceLabel || '',
  };
};

const overridesFromDraft = (draft, includeSchedule) => {
  const overrides = {
    title: draft.title.trim() || null,
    location: draft.location.trim() || null,
  };
  if (!includeSchedule) return overrides;
  if (draft.scheduleKind === 'ONE_TIME') {
    overrides.schedule = {
      kind: 'ONE_TIME',
      localStart: draft.localStart,
      localEnd: draft.localEnd || null,
    };
  } else if (draft.scheduleKind === 'RECURRENCE') {
    overrides.schedule = {
      kind: 'RECURRENCE',
      recurrenceLabel: draft.recurrenceLabel.trim(),
    };
  } else {
    overrides.schedule = null;
  }
  return overrides;
};

const researchInProgress = research => ['QUEUED', 'RUNNING'].includes(research?.status);

const workerIsOnline = worker => {
  if (worker?.status !== 'ONLINE' || !worker.leaseUntil) return false;
  const leaseUntil = worker.leaseUntil instanceof Date
    ? worker.leaseUntil
    : new Date(worker.leaseUntil);
  return !Number.isNaN(leaseUntil.getTime()) && leaseUntil.getTime() > Date.now();
};

const researchLeaseExpired = research => {
  if (research?.status !== 'RUNNING' || !research.queue?.leaseUntil) return false;
  const leaseUntil = research.queue.leaseUntil instanceof Date
    ? research.queue.leaseUntil
    : new Date(research.queue.leaseUntil);
  return Number.isNaN(leaseUntil.getTime()) || leaseUntil.getTime() <= Date.now();
};

const researchActionLabel = research => {
  if (research?.status === 'QUEUED') return 'Research queued';
  if (research?.status === 'RUNNING') return 'Finding details…';
  if (research?.status === 'FAILED' || research?.status === 'UNAVAILABLE') {
    return 'Retry missing details';
  }
  return 'Find missing details';
};

const canResearchCandidate = (candidate, previewErrorCode) => (
  candidate.reviewStatus === 'PENDING'
  && Boolean(previewErrorCode)
);

const candidateIdentity = candidate => (
  `${documentKey(candidate)}\u0000${String(candidate?.sourceItemKey || '')}`
);

const fallbackParentLabel = sourceItemKey => {
  const label = String(sourceItemKey || '').replace(/^group:/, '').replaceAll(/[-_]+/g, ' ').trim();
  return label ? label.replace(/\b\w/g, character => character.toUpperCase()) : null;
};

const statusTone = value => {
  const normalized = String(value || '').toUpperCase();
  if (normalized.includes('FAIL') || normalized.includes('ERROR') || normalized.includes('INVALID') || normalized.includes('REJECT')) return 'danger';
  if (normalized.includes('APPROV') || normalized.includes('VALID') || normalized === 'PUBLISHED') return 'positive';
  return 'pending';
};

const approvalClaimIsStale = candidate => {
  const claimedAt = candidate.approvalClaimedAt instanceof Date
    ? candidate.approvalClaimedAt
    : new Date(candidate.approvalClaimedAt || 0);
  return Number.isNaN(claimedAt.getTime())
    || claimedAt.getTime() < Date.now() - APPROVAL_CLAIM_TTL_MS;
};

const needsPublicationRepair = candidate => (
  candidate.reviewStatus === 'APPROVED'
  && (candidate.publicationState === 'FAILED'
    || (candidate.publicationState === 'APPLYING' && approvalClaimIsStale(candidate)))
);

const candidateDisplayStatus = candidate => {
  if (candidate.reviewStatus !== 'APPROVED') {
    return candidate.reviewStatus || candidate.validationState;
  }
  if (candidate.publicationState === 'FAILED') return 'PUBLICATION_FAILED';
  if (candidate.publicationState === 'APPLYING') return 'PUBLICATION_APPLYING';
  return 'PUBLISHED';
};

const matchesStatusFilter = (candidate, filter) => {
  if (filter === 'ALL') return true;
  if (filter === 'NEEDS_PUBLICATION_REPAIR') return needsPublicationRepair(candidate);
  return candidate.reviewStatus === filter;
};

const approvalBlock = (candidate, source, sandboxEnabled) => {
  const staleApproval = candidate.reviewStatus === 'APPROVING'
    && approvalClaimIsStale(candidate);
  const repairablePublication = needsPublicationRepair(candidate);
  if (candidate.reviewStatus !== 'PENDING' && !staleApproval && !repairablePublication) {
    if (candidate.reviewStatus === 'APPROVED') {
      if (candidate.publicationState === 'APPLYING') {
        return 'Publication is currently in progress. It becomes retryable if the claim does not finish within five minutes.';
      }
      return 'This candidate has already been approved and published.';
    }
    if (candidate.reviewStatus === 'APPROVING') {
      return 'Publication is currently in progress. It becomes retryable if the claim does not finish within five minutes.';
    }
    return `This candidate is ${humanizeToken(candidate.reviewStatus).toLowerCase()} and cannot be approved.`;
  }
  const hasReviewedCorrection = Number.isInteger(candidate.editorialRevision)
    && candidate.editorialRevision > 0;
  if (candidate.validationState !== 'VALID' && !hasReviewedCorrection) {
    return 'Automated checks did not pass. Use Edit details to make a reviewed correction before publication.';
  }
  if (!source) return 'The registered source is unavailable, so publication is blocked.';
  if (!sandboxEnabled && source.permission === 'PROBE_REQUIRED') {
    return 'This source needs approved collection and republication permission before anything can publish.';
  }
  if (!sandboxEnabled && !documentKey(candidate).startsWith('SEN-')) {
    return 'This source does not yet have an approved public projection.';
  }
  if (!sandboxEnabled && documentKey(candidate) === 'SEN-005') {
    return 'Blocked until retained republication permission evidence is recorded for this support source.';
  }
  if (documentKey(candidate).startsWith('SEN-')
      && (candidate.reviewLane !== 'SENSITIVE'
        || candidate.privacyReviewRequired !== true
        || candidate.projectionEligibility !== 'REQUIRES_SENSITIVE_REVIEW')) {
    return 'Sensitive-review safeguards are incomplete. This support listing must remain private.';
  }
  if (!['event', 'group'].includes(candidateKind(candidate))) {
    return 'Only event and group candidates can be published.';
  }
  return null;
};

const approvalActionLabel = (candidate, isBusy) => {
  if (isBusy) return 'Approving…';
  if (candidate.reviewStatus === 'APPROVED') return 'Retry publication';
  if (candidate.reviewStatus === 'APPROVING') return 'Retry approval';
  return 'Approve';
};

const formatDateOnly = value => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Pacific/Honolulu',
  }).format(date);
};

const unitSchedule = unit => {
  if (unit.candidates.length === 1) return candidateSchedule(unit.candidates[0]);
  const starts = unit.candidates.map(candidateStart).filter(Boolean);
  if (!starts.length) return `${unit.candidates.length} related listings`;
  const first = starts[0];
  const last = starts[starts.length - 1];
  const time = first.tz('Pacific/Honolulu').format('h:mm A');
  return `${unit.candidates.length} dates · ${formatDateOnly(first.toDate())} – ${formatDateOnly(last.toDate())} · ${time}`;
};

const previewItems = result => {
  if (Array.isArray(result)) return result;
  if (Array.isArray(result?.items)) return result.items;
  if (Array.isArray(result?.previews)) return result.previews;
  return [];
};

const callMethod = (name, ...args) => new Promise((resolve, reject) => {
  Meteor.call(name, ...args, (error, result) => {
    if (error) reject(error);
    else resolve(result);
  });
});

const classificationFallback = Object.freeze({
  topicKey: 'community',
  subcategoryKey: 'cultural_community',
  confidence: 0.25,
});

const hasPotentiallyBulkSafeClassification = candidate => {
  if (documentKey(candidate).startsWith('SEN-')) return true;
  const suggestion = candidate.classificationSuggestion;
  return suggestion?.taxonomyVersion === 'matchbook-topics.v1'
    && Number.isFinite(suggestion.confidence)
    && suggestion.confidence >= 0.95
    && Array.isArray(suggestion.reasons)
    && suggestion.reasons.includes('SOURCE_CATEGORY_MATCH')
    && !suggestion.reasons.includes('FALLBACK_COMMUNITY')
    && subcategoryOptionsFor(suggestion.topicKey)
      .some(option => option.key === suggestion.subcategoryKey);
};

const hasBulkSafeClassification = (candidate, previews) => (
  previewForCandidate(previews, candidate._id)?.bulkApprovalEligible === true
);

const PREVIEW_ERROR_COPY = Object.freeze({
  'ingestion-candidate-not-found': 'This review item is no longer available. Refresh the page.',
  'ingestion-candidate-superseded': 'A newer version of this listing is waiting for review.',
  'ingestion-event-duration-review-required': 'The event duration needs a human correction before publication.',
  'ingestion-event-outside-promotion-window': 'This event is outside the rolling two-month publication window.',
  'ingestion-invalid-date': 'The source date or time could not be read safely.',
  'ingestion-missing-date': 'An event date or recurrence schedule is required before publication.',
  'ingestion-missing-required-field': 'A required title, location, or schedule field is missing.',
  'ingestion-not-publishable': 'This source record is not an event or group that can be published.',
  'ingestion-unsupported-recurrence': 'This recurrence pattern needs a human correction before publication.',
  'ingestion-unsupported-time-zone': 'This event uses a time zone MatchBook cannot safely publish yet.',
});

const previewErrorCopy = errorCode => (
  PREVIEW_ERROR_COPY[errorCode]
  || `Publication check stopped: ${humanizeToken(errorCode)}.`
);

const previewErrorForUnit = (unit, previews) => (
  previewCandidateIdsForUnit(unit)
    .map(candidateId => previewForCandidate(previews, candidateId)?.errorCode)
    .find(Boolean)
);

const safeDuplicateMatches = (unit, previews) => {
  const matches = unit.candidates.flatMap(candidate => (
    previews[String(candidate._id)]?.duplicates
    || previews[String(candidate._id)]?.matches
    || []
  ));
  const uniqueMatches = new Map();
  matches.forEach(match => {
    const key = String(match.id || match._id || `${match.title}|${match.date}|${match.location}`);
    if (!uniqueMatches.has(key)) uniqueMatches.set(key, match);
  });
  return [...uniqueMatches.values()].slice(0, 3);
};

const unitApprovalBlock = (
  unit,
  sourceById,
  sandboxEnabled,
  previews,
  requirePreview = true,
) => {
  const policyBlock = unit.candidates.map(candidate => (
    approvalBlock(candidate, sourceById.get(documentKey(candidate)), sandboxEnabled)
  )).find(Boolean);
  if (policyBlock) return policyBlock;
  const requiredPreviewIds = previewCandidateIdsForUnit(unit);
  if (requiredPreviewIds.some(candidateId => !previewForCandidate(previews, candidateId))) {
    return requirePreview
      ? 'Checking the publication impact and existing MatchBook listings…'
      : null;
  }
  const previewErrorCode = previewErrorForUnit(unit, previews);
  if (previewErrorCode) return previewErrorCopy(previewErrorCode);
  const duplicateLevel = duplicateLevelForUnit(unit, previews);
  const projection = projectionSummaryForUnit(unit, previews);
  const duplicateAcknowledgmentBlocked = requiredPreviewIds.some(candidateId => (
    previewForCandidate(previews, candidateId)?.duplicateReviewAcknowledgmentAllowed === false
  ));
  if (unit.candidates.length === 1
      && duplicateLevel === 'REVIEW'
      && (duplicateAcknowledgmentBlocked || projection.projectedRecordCount > 1)) {
    return `This recurring template would publish ${projection.projectedRecordCount} dates near an existing listing. Resolve or merge the match before publication.`;
  }
  if (unit.candidates.length === 1 && duplicateLevel === 'BLOCK') {
    return 'This listing appears to already be on MatchBook. It will not be added a second time.';
  }
  return null;
};

const Status = ({ children, tone }) => (
  <span className={`event-intake-status event-intake-status--${tone}`}>{children}</span>
);

Status.propTypes = {
  children: PropTypes.node.isRequired,
  tone: PropTypes.oneOf(['danger', 'pending', 'positive']),
};

Status.defaultProps = {
  tone: 'pending',
};

const ReviewStat = ({ icon, label, value }) => (
  <div className="mb-panel event-intake-stat">
    <span className="event-intake-stat-icon" aria-hidden="true">{icon}</span>
    <strong>{value}</strong>
    <span>{label}</span>
  </div>
);

ReviewStat.propTypes = {
  icon: PropTypes.node.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
};

const EventReview = () => {
  const [sourceFilter, setSourceFilter] = useState('ALL');
  const [statusFilter, setStatusFilter] = useState('PENDING');
  const [kindFilter, setKindFilter] = useState('ALL');
  const [searchText, setSearchText] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(30);
  const [busyIds, setBusyIds] = useState([]);
  const [approvingAll, setApprovingAll] = useState(false);
  const [clearingAll, setClearingAll] = useState(false);
  const [clearingOutside, setClearingOutside] = useState(false);
  const [reopeningOutside, setReopeningOutside] = useState(false);
  const [notice, setNotice] = useState(null);
  const [previews, setPreviews] = useState({});
  const [previewError, setPreviewError] = useState(null);
  const [reviewSelections, setReviewSelections] = useState({});
  const [editingUnitId, setEditingUnitId] = useState(null);
  const [editorDraft, setEditorDraft] = useState(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [researchBusyIds, setResearchBusyIds] = useState([]);
  const [reviewNow] = useState(() => new Date());
  const sandboxEnabled = Meteor.settings.public?.communityIngestionSandbox === true;

  const {
    candidates,
    ready,
    sources,
    workers,
  } = useTracker(() => {
    const sourceSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.sources);
    const candidateSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.candidates);
    const researchSubscription = Meteor.subscribe(INGESTION_RESEARCH_PUBLICATION);
    const workerSubscription = Meteor.subscribe(INGESTION_WORKER_HEALTH_PUBLICATION);
    return {
      sources: CommunitySources.find({}, { sort: { displayName: 1, slug: 1 } }).fetch(),
      candidates: IngestionCandidates.find({}, { sort: { createdAt: -1 }, limit: 5000 }).fetch(),
      workers: IngestionWorkerHealth.find({}, { sort: { heartbeatAt: -1 } }).fetch(),
      ready: sourceSubscription.ready()
        && candidateSubscription.ready()
        && researchSubscription.ready()
        && workerSubscription.ready(),
    };
  }, []);

  const sourceById = useMemo(() => (
    new Map(sources.map(source => [documentKey(source), source]))
  ), [sources]);
  const candidateByIdentity = useMemo(() => {
    const index = new Map();
    candidates.forEach(candidate => {
      const identity = candidateIdentity(candidate);
      if (!index.has(identity)) index.set(identity, candidate);
    });
    return index;
  }, [candidates]);
  const candidateById = useMemo(() => (
    new Map(candidates.map(candidate => [String(candidate._id), candidate]))
  ), [candidates]);
  const filteredCandidates = useMemo(() => {
    const query = searchText.trim().toLowerCase();
    return candidates.filter(candidate => {
      const source = sourceById.get(documentKey(candidate));
      const searchable = [
        candidateTitle(candidate),
        candidateLocation(candidate),
        sourceName(source),
      ].filter(Boolean).join(' ').toLowerCase();
      return (sourceFilter === 'ALL' || documentKey(candidate) === sourceFilter)
        && matchesStatusFilter(candidate, statusFilter)
        && (kindFilter === 'ALL' || candidateKind(candidate) === kindFilter)
        && (!query || searchable.includes(query));
    });
  }, [candidates, kindFilter, searchText, sourceById, sourceFilter, statusFilter]);
  const reviewModel = useMemo(() => (
    buildReviewUnits(filteredCandidates, previews, reviewNow)
  ), [filteredCandidates, previews, reviewNow]);
  const pendingCandidates = useMemo(() => (
    candidates.filter(candidate => candidate.reviewStatus === 'PENDING')
  ), [candidates]);
  const pendingQueueModel = useMemo(() => (
    buildReviewUnits(pendingCandidates, previews, reviewNow)
  ), [pendingCandidates, previews, reviewNow]);
  const pendingSummary = useMemo(() => (
    pendingReviewQueueSummary(candidates, reviewNow, previews)
  ), [candidates, previews, reviewNow]);
  const inWindowPendingCandidates = useMemo(() => (
    pendingQueueModel.units.flatMap(unit => unit.candidates)
  ), [pendingQueueModel]);
  const displayedUnits = reviewModel.units.slice(0, visibleLimit);
  const remainingUnits = Math.max(0, reviewModel.units.length - displayedUnits.length);
  const previewIds = useMemo(() => (
    [...new Set([
      ...inWindowPendingCandidates
        .filter(hasPotentiallyBulkSafeClassification)
        .map(candidate => String(candidate._id)),
      ...displayedUnits.flatMap(previewCandidateIdsForUnit),
    ])].slice(0, MAX_BULK_CANDIDATES)
  ), [displayedUnits, inWindowPendingCandidates]);
  const previewRequestKey = previewIds.map(candidateId => {
    const candidate = candidateById.get(candidateId);
    return previewRequestBasisFor(candidate);
  }).join('|');

  useEffect(() => {
    if (!ready || !previewIds.length) return undefined;
    let active = true;
    Meteor.call(REVIEW_METHODS.preview, previewIds, (error, result) => {
      if (!active) return;
      if (error) {
        setPreviewError(error.reason || error.message || 'Duplicate analysis is temporarily unavailable.');
        return;
      }
      const next = {};
      previewItems(result).forEach(item => {
        if (item?.candidateId) next[String(item.candidateId)] = item;
      });
      setPreviews(current => ({ ...current, ...next }));
      setPreviewError(null);
    });
    return () => {
      active = false;
    };
  }, [previewRequestKey, ready]);

  if (!ready) return <LoadingSpinner />;

  const workerOnline = workers.some(workerIsOnline);
  const activeResearchCandidates = candidates.filter(candidate => (
    researchInProgress(currentResearchFor(candidate))
  ));
  const stalledResearchCount = activeResearchCandidates.filter(candidate => (
    researchLeaseExpired(currentResearchFor(candidate))
  )).length;

  const eligibleUnits = reviewModel.units.filter(unit => (
    !unitApprovalBlock(unit, sourceById, sandboxEnabled, previews)
  ));
  const bulkEligibleUnits = eligibleUnits.filter(unit => (
    unit.candidates.every(candidate => hasBulkSafeClassification(candidate, previews))
  ));
  const blockedUnits = pendingQueueModel.units.filter(unit => (
    unitApprovalBlock(unit, sourceById, sandboxEnabled, previews, false)
  ));
  const clearableCandidateIds = [...new Set(reviewModel.units.flatMap(unit => (
    unit.candidates
      .filter(candidate => candidate.reviewStatus === 'PENDING')
      .map(candidate => String(candidate._id))
  )))];
  const clearableUnitCount = reviewModel.units.filter(unit => (
    unit.candidates.some(candidate => candidate.reviewStatus === 'PENDING')
  )).length;
  const outsideWindowCandidateIds = candidates
    .filter(candidate => candidate.reviewStatus === 'PENDING')
    .filter(candidate => !candidateWithinReviewWindow(candidate, reviewNow))
    .map(candidate => String(candidate._id));
  const clearedOutsideWindowCandidateIds = candidates
    .filter(candidate => candidate.reviewStatus === 'REJECTED')
    .filter(candidate => candidate.clearReason === 'OUTSIDE_REVIEW_WINDOW')
    .filter(candidate => !candidateWithinReviewWindow(candidate, reviewNow))
    .map(candidate => String(candidate._id));

  const updateFilter = setter => event => {
    setter(event.target.value);
    setVisibleLimit(30);
  };

  const selectionForUnit = unit => (
    reviewSelections[unit.id]
    || effectiveClassificationForUnit(unit, previews)
    || classificationFallback
  );

  const setUnitTopic = (unit, topicKey) => {
    const firstSubcategory = subcategoryOptionsFor(topicKey)[0]?.key;
    if (!firstSubcategory) return;
    setReviewSelections(current => ({
      ...current,
      [unit.id]: { topicKey, subcategoryKey: firstSubcategory, confidence: 1 },
    }));
  };

  const setUnitSubcategory = (unit, subcategoryKey) => {
    const currentSelection = selectionForUnit(unit);
    setReviewSelections(current => ({
      ...current,
      [unit.id]: { ...currentSelection, subcategoryKey, confidence: 1 },
    }));
  };

  const startEditing = (unit, suggestions = []) => {
    const draft = editorialDraftFor(unit.candidates[0]);
    suggestions.forEach(suggestion => {
      if (suggestion.field === 'title') draft.title = String(suggestion.value || '');
      if (suggestion.field === 'location') draft.location = String(suggestion.value || '');
      if (suggestion.field === 'localStart') {
        draft.scheduleKind = 'ONE_TIME';
        draft.localStart = editorDateTime(suggestion.value);
      }
      if (suggestion.field === 'localEnd') {
        draft.scheduleKind = 'ONE_TIME';
        draft.localEnd = editorDateTime(suggestion.value);
      }
      if (suggestion.field === 'recurrenceLabel') {
        draft.scheduleKind = 'RECURRENCE';
        draft.recurrenceLabel = String(suggestion.value || '');
      }
    });
    setEditingUnitId(unit.id);
    setEditorDraft(draft);
  };

  const closeEditor = () => {
    setEditingUnitId(null);
    setEditorDraft(null);
  };

  const updateEditor = field => event => {
    const { value } = event.target;
    setEditorDraft(current => ({ ...current, [field]: value }));
  };

  const saveEditorialChanges = async unit => {
    if (!editorDraft) return;
    const includeSchedule = true;
    if (includeSchedule && editorDraft.scheduleKind === 'ONE_TIME' && !editorDraft.localStart) {
      setNotice({ tone: 'danger', message: 'Choose a start date and time, or select a different schedule type.' });
      return;
    }
    if (includeSchedule
        && editorDraft.scheduleKind === 'RECURRENCE'
        && !editorDraft.recurrenceLabel.trim()) {
      setNotice({ tone: 'danger', message: 'Enter the repeating schedule in plain language.' });
      return;
    }
    const overrides = overridesFromDraft(editorDraft, includeSchedule);
    setSavingEdit(true);
    setNotice({ tone: 'pending', message: 'Saving the reviewed details and rechecking publication…' });
    try {
      const candidate = unit.candidates[0];
      const editToken = candidate.editorialEditToken
        || previewForCandidate(previews, candidate._id)?.editorialEditToken;
      if (!editToken) {
        throw new Error('The editable review version is still loading. Refresh this card and try again.');
      }
      await callMethod(
        REVIEW_METHODS.saveEditorialOverrides,
        String(candidate._id),
        editToken,
        overrides,
      );
      setNotice({
        tone: 'positive',
        message: unit.candidates.length > 1
          ? 'Saved this occurrence only. MatchBook is regrouping it from the reviewed facts now.'
          : 'Saved the reviewed details. Duplicate and publication checks are refreshing now.',
      });
      closeEditor();
    } catch (error) {
      const message = error.reason || error.message || 'The reviewed details could not be saved.';
      setNotice({ tone: 'danger', message });
      swal('Could not save details', message, 'error');
    } finally {
      setSavingEdit(false);
    }
  };

  const requestMissingDetails = candidate => {
    const candidateId = String(candidate._id);
    setResearchBusyIds(current => [...new Set([...current, candidateId])]);
    setNotice({ tone: 'pending', message: `Checking official sources for ${candidateTitle(candidate)}…` });
    Meteor.call(REVIEW_METHODS.requestResearch, candidateId, (error, result) => {
      setResearchBusyIds(current => current.filter(id => id !== candidateId));
      if (error) {
        const message = error.reason || error.message || 'The detail search could not be queued.';
        setNotice({ tone: 'danger', message });
        swal('Could not research details', message, 'error');
        return;
      }
      const alreadyRunning = result?.status === 'ALREADY_RUNNING';
      const alreadyCurrent = result?.status === 'ALREADY_CURRENT';
      let message = 'Detail research is queued. The card will update with evidence and suggestions.';
      if (alreadyCurrent) message = 'The latest research is already shown on this card.';
      else if (alreadyRunning) {
        message = 'This exact candidate search is already queued or running. Its progress remains on the card.';
      } else if (result?.busyScope === 'SOURCE') {
        message = 'Detail research is queued behind another job for this source. It will run automatically and was not discarded.';
      }
      setNotice({
        tone: 'pending',
        message,
      });
    });
  };

  const approveUnit = (unit, extraOptions = {}) => {
    const representative = unit.candidates[0];
    const projection = projectionSummaryForUnit(unit, previews);
    const selection = selectionForUnit(unit);
    const representativePreview = previewForCandidate(previews, representative._id);
    const options = {
      topicKey: selection.topicKey,
      subcategoryKey: selection.subcategoryKey,
      ...(representativePreview?.editorialPreviewToken
        ? { editorialPreviewToken: representativePreview.editorialPreviewToken }
        : {}),
      ...(unit.candidates.length === 1
        && projection.projectedRecordCount === 1
        && previewForCandidate(previews, representative._id)
          ?.duplicateReviewAcknowledgmentAllowed !== false
        && duplicateLevelForUnit(unit, previews) === 'REVIEW'
        ? { duplicateReviewAcknowledged: true }
        : {}),
      ...extraOptions,
    };
    const isSeries = unit.candidates.length > 1;
    const method = isSeries ? REVIEW_METHODS.approveSeries : REVIEW_METHODS.approve;
    const target = isSeries
      ? unit.candidates.map(candidate => String(candidate._id))
      : String(representative._id);
    setBusyIds(current => [...new Set([...current, unit.id])]);
    setNotice({
      tone: 'pending',
      message: projection.projectedRecordCount > 1
        ? `Publishing ${projection.projectedRecordCount} dates for ${candidateTitle(representative)}…`
        : `Publishing ${candidateTitle(representative)}…`,
    });
    Meteor.call(method, target, options, (error, result) => {
      setBusyIds(current => current.filter(id => id !== unit.id));
      if (error) {
        const message = error.reason || error.message || 'This review item could not be approved.';
        setNotice({ tone: 'danger', message });
        swal('Approval stopped', message, 'error');
        return;
      }
      const repaired = result?.outcome === 'PUBLICATION_REPAIRED';
      const approved = result?.approved ?? (result?.outcome ? 1 : 0);
      const blocked = result?.blocked || 0;
      const count = result?.canonicalRecordsPublished
        ?? result?.canonicalCount
        ?? result?.canonicalRecords
        ?? 0;
      const message = projection.projectedRecordCount > 1 || isSeries
        ? `${count} public event${count === 1 ? '' : 's'} published from ${approved} approved review record${approved === 1 ? '' : 's'}${blocked ? `; ${blocked} duplicate or blocked record${blocked === 1 ? '' : 's'} skipped` : ''}.`
        : `${candidateTitle(representative)} ${repaired ? 'had its publication repaired' : 'was approved'}${count ? ` and published to ${count} public record${count === 1 ? '' : 's'}` : ''}.`;
      setNotice({ tone: blocked ? 'pending' : 'positive', message });
      swal(repaired ? 'Publication repaired' : 'Approved', message, blocked ? 'warning' : 'success');
    });
  };

  const handleApprove = async unit => {
    const representative = unit.candidates[0];
    const projection = projectionSummaryForUnit(unit, previews);
    const repairing = representative.reviewStatus === 'APPROVED';
    const repeated = projection.projectedRecordCount > 1 || unit.candidates.length > 1;
    const duplicateLevel = duplicateLevelForUnit(unit, previews);
    let promptText = 'This publishes the event or group using the category selected on this card after one final duplicate check.';
    let confirmText = 'Approve and publish';
    if (repairing) {
      promptText = 'The approval decision is already recorded. This retries the interrupted, idempotent publication.';
    } else if (duplicateLevel === 'REVIEW') {
      promptText = 'A similar event is already on MatchBook. Compare the match on this card before deciding to publish another event.';
      confirmText = 'I checked — approve';
    } else if (repeated) {
      promptText = `One approval will publish ${projection.projectedRecordCount} upcoming dates in this repeated series. Possible and likely duplicate dates are skipped.`;
    }
    const confirmed = await swal({
      title: repairing
        ? `Retry publication for ${candidateTitle(representative)}?`
        : `Approve ${candidateTitle(representative)}?`,
      text: promptText,
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep in review', value: false, visible: true },
        confirm: { text: repairing ? 'Retry publication' : confirmText, value: true, visible: true },
      },
    });
    if (confirmed) approveUnit(unit);
  };

  const handleDuplicateOverride = async unit => {
    const representative = unit.candidates[0];
    const confirmed = await swal({
      title: `Publish ${candidateTitle(representative)} anyway?`,
      text: 'This is a sandbox-only override for a likely duplicate. The override is recorded in the review audit trail.',
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep blocked', value: false, visible: true },
        confirm: { text: 'Override and publish', value: true, visible: true },
      },
    });
    if (confirmed) approveUnit(unit, { duplicateOverride: true });
  };

  const approveAllCandidateIds = [];
  let approveAllUnitCount = 0;
  let approveAllProjectedRecords = 0;
  bulkEligibleUnits.some(unit => {
    const projection = projectionSummaryForUnit(unit, previews);
    if (!Number.isInteger(projection.projectedRecordCount)) return false;
    if (approveAllCandidateIds.length + unit.candidates.length > MAX_BULK_CANDIDATES) return true;
    if (approveAllProjectedRecords + projection.projectedRecordCount
        > MAX_BULK_PROJECTED_RECORDS) return true;
    approveAllCandidateIds.push(...unit.candidates.map(candidate => String(candidate._id)));
    approveAllUnitCount += 1;
    approveAllProjectedRecords += projection.projectedRecordCount;
    return false;
  });

  const handleApproveAll = async () => {
    if (!approveAllCandidateIds.length) return;
    const recordWord = approveAllProjectedRecords === 1 ? 'public record' : 'public records';
    const confirmationText = `This batch contains ${approveAllCandidateIds.length} reviewed source records and can create or update ${approveAllProjectedRecords} ${recordWord}. `
      + 'Only protected support categories and high-confidence source categories are included; likely duplicates stay unapproved. '
      + 'Review cards individually when a category needs confirmation or adjustment.';
    const confirmed = await swal({
      title: `Approve ${approveAllUnitCount} review item${approveAllUnitCount === 1 ? '' : 's'}?`,
      text: confirmationText,
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep in review', value: false, visible: true },
        confirm: { text: 'Approve all and publish', value: true, visible: true },
      },
    });
    if (!confirmed) return;

    setApprovingAll(true);
    setNotice({ tone: 'pending', message: `Publishing up to ${approveAllProjectedRecords} reviewed public records…` });
    Meteor.call(
      REVIEW_METHODS.approveAll,
      approveAllCandidateIds,
      { confirmAutomaticClassifications: true },
      (error, result) => {
        setApprovingAll(false);
        if (error) {
          const message = error.reason || error.message || 'The reviewed candidates could not be approved.';
          setNotice({ tone: 'danger', message });
          swal('Approve all stopped', message, 'error');
          return;
        }
        const published = result.canonicalRecordsPublished || 0;
        const message = `${result.approved} review records approved and ${published} public records published; ${result.blocked} blocked, ${result.failed} failed, and ${result.skipped} skipped.`;
        const tone = result.failed || result.blocked ? 'pending' : 'positive';
        setNotice({ tone, message: `Approval finished: ${message}` });
        swal('Approval finished', message, result.failed || result.blocked ? 'warning' : 'success');
      },
    );
  };

  const handleClearUnit = async unit => {
    const candidateIds = unit.candidates
      .filter(candidate => candidate.reviewStatus === 'PENDING')
      .map(candidate => String(candidate._id));
    if (!candidateIds.length) return;
    const representative = unit.candidates[0];
    const confirmed = await swal({
      title: `Clear ${candidateTitle(representative)} from review?`,
      text: `This removes ${candidateIds.length} pending source record${candidateIds.length === 1 ? '' : 's'} from the queue. It does not approve, publish, or delete anything, and you can restore it from the Cleared / skipped filter.`,
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep in review', value: false, visible: true },
        confirm: { text: 'Clear from review', value: true, visible: true },
      },
    });
    if (!confirmed) return;
    setBusyIds(current => [...new Set([...current, unit.id])]);
    setNotice({ tone: 'pending', message: `Clearing ${candidateTitle(representative)} from the review queue…` });
    try {
      const result = await callMethod(REVIEW_METHODS.clear, candidateIds, 'REVIEWED_SKIP');
      setNotice({
        tone: result.skipped ? 'pending' : 'positive',
        message: `${result.changed} source record${result.changed === 1 ? '' : 's'} cleared; ${result.skipped} skipped because its state changed.`,
      });
    } catch (error) {
      const message = error.reason || error.message || 'The review item could not be cleared.';
      setNotice({ tone: 'danger', message });
      swal('Could not clear review item', message, 'error');
    } finally {
      setBusyIds(current => current.filter(id => id !== unit.id));
    }
  };

  const handleReopenUnit = async unit => {
    const candidateIds = unit.candidates
      .filter(candidate => candidate.reviewStatus === 'REJECTED')
      .map(candidate => String(candidate._id));
    if (!candidateIds.length) return;
    setBusyIds(current => [...new Set([...current, unit.id])]);
    setNotice({ tone: 'pending', message: 'Restoring the cleared review item…' });
    try {
      const result = await callMethod(REVIEW_METHODS.reopen, candidateIds);
      setNotice({
        tone: result.skipped ? 'pending' : 'positive',
        message: `${result.changed} source record${result.changed === 1 ? '' : 's'} restored to pending review.`,
      });
    } catch (error) {
      const message = error.reason || error.message || 'The cleared review item could not be restored.';
      setNotice({ tone: 'danger', message });
      swal('Could not restore review item', message, 'error');
    } finally {
      setBusyIds(current => current.filter(id => id !== unit.id));
    }
  };

  const handleClearCurrentScope = async () => {
    if (!clearableCandidateIds.length) return;
    const confirmed = await swal({
      title: `Clear ${clearableUnitCount} filtered review card${clearableUnitCount === 1 ? '' : 's'}?`,
      text: `This clears ${clearableCandidateIds.length} pending source record${clearableCandidateIds.length === 1 ? '' : 's'} in the current search, source, type, and status filters. `
        + 'It does not approve, publish, or delete source evidence, Events, or Groups. Cleared cards remain restorable.',
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep in review', value: false, visible: true },
        confirm: { text: 'Clear filtered cards', value: true, visible: true },
      },
    });
    if (!confirmed) return;
    setClearingAll(true);
    setNotice({ tone: 'pending', message: `Clearing ${clearableUnitCount} filtered review cards…` });
    try {
      const result = await callMethod(
        REVIEW_METHODS.clear,
        clearableCandidateIds,
        'REVIEWED_SKIP',
      );
      const message = `${result.changed} source records cleared; ${result.alreadyInState} already cleared and ${result.skipped} skipped because their state changed.`;
      setNotice({ tone: result.skipped ? 'pending' : 'positive', message });
      swal('Filtered review cards cleared', message, result.skipped ? 'warning' : 'success');
    } catch (error) {
      const message = error.reason || error.message || 'The filtered review cards could not be cleared.';
      setNotice({ tone: 'danger', message });
      swal('Clear all stopped', message, 'error');
    } finally {
      setClearingAll(false);
    }
  };

  const handleClearOutsideWindow = async () => {
    if (!outsideWindowCandidateIds.length) return;
    const confirmed = await swal({
      title: `Clear ${outsideWindowCandidateIds.length} outside-window records?`,
      text: `These dated source records are beyond the rolling ${REVIEW_HORIZON_MONTHS}-month review window and are not part of today’s actionable count. `
        + 'Clearing them will keep them out of review when their dates approach; it does not delete evidence or public data, and this outside-window batch can be restored.',
      icon: 'warning',
      buttons: {
        cancel: { text: 'Keep future records', value: false, visible: true },
        confirm: { text: 'Clear future backlog', value: true, visible: true },
      },
    });
    if (!confirmed) return;
    setClearingOutside(true);
    setNotice({ tone: 'pending', message: 'Clearing the outside-window pending backlog…' });
    try {
      const result = await callMethod(
        REVIEW_METHODS.clear,
        outsideWindowCandidateIds,
        'OUTSIDE_REVIEW_WINDOW',
      );
      const message = `${result.changed} outside-window source records cleared; ${result.skipped} skipped because their state changed.`;
      setNotice({ tone: result.skipped ? 'pending' : 'positive', message });
      swal('Future backlog cleared', message, result.skipped ? 'warning' : 'success');
    } catch (error) {
      const message = error.reason || error.message || 'The outside-window backlog could not be cleared.';
      setNotice({ tone: 'danger', message });
      swal('Future backlog clear stopped', message, 'error');
    } finally {
      setClearingOutside(false);
    }
  };

  const handleReopenOutsideWindow = async () => {
    if (!clearedOutsideWindowCandidateIds.length) return;
    const confirmed = await swal({
      title: `Restore ${clearedOutsideWindowCandidateIds.length} outside-window records?`,
      text: 'This returns only the previously cleared outside-window batch to pending. It will remain hidden until each date enters the rolling review window.',
      icon: 'warning',
      buttons: {
        cancel: { text: 'Leave cleared', value: false, visible: true },
        confirm: { text: 'Restore future backlog', value: true, visible: true },
      },
    });
    if (!confirmed) return;
    setReopeningOutside(true);
    setNotice({ tone: 'pending', message: 'Restoring the outside-window backlog…' });
    try {
      const result = await callMethod(REVIEW_METHODS.reopen, clearedOutsideWindowCandidateIds);
      const message = `${result.changed} outside-window source records restored; ${result.skipped} skipped because their state changed.`;
      setNotice({ tone: result.skipped ? 'pending' : 'positive', message });
      swal('Future backlog restored', message, result.skipped ? 'warning' : 'success');
    } catch (error) {
      const message = error.reason || error.message || 'The outside-window backlog could not be restored.';
      setNotice({ tone: 'danger', message });
      swal('Restore stopped', message, 'error');
    } finally {
      setReopeningOutside(false);
    }
  };

  return (
    <Container id="event-review" className="page-shell py-5">
      <PageHead
        title="Candidate review"
        eyebrow="Admin"
        action={(
          <Link className="btn btn-soft-primary" to="/admin/event-intake">
            <ArrowLeft aria-hidden="true" />
            Event intake
          </Link>
        )}
      >
        Review one card per event series, choose its category, compare possible duplicates, and publish only the next {REVIEW_HORIZON_MONTHS} months.
      </PageHead>

      <aside className="event-intake-boundary" aria-labelledby="event-review-boundary-title">
        <ShieldLock aria-hidden="true" />
        <div>
          <h2 id="event-review-boundary-title">Approval is the publication boundary</h2>
          <p>Nothing publishes automatically. Repeated dates share one approval, while every occurrence still receives its own duplicate check.</p>
        </div>
      </aside>

      {activeResearchCandidates.length > 0 && (
        <aside
          className={`event-review-worker-status ${workerOnline ? 'is-online' : 'is-offline'}`}
          aria-live="polite"
        >
          <ArrowRepeat aria-hidden="true" />
          <div>
            <strong>
              {workerOnline
                ? 'Detail research worker is online'
                : 'Detail searches are queued safely; the research worker is offline'}
            </strong>
            <p>
              {workerOnline
                ? `${activeResearchCandidates.length} candidate search${activeResearchCandidates.length === 1 ? '' : 'es'} waiting or running. Progress is shown on each card.`
                : `${activeResearchCandidates.length} candidate search${activeResearchCandidates.length === 1 ? '' : 'es'} will resume automatically when the worker returns. Nothing was discarded.`}
              {stalledResearchCount > 0
                ? ` ${stalledResearchCount} expired worker lease${stalledResearchCount === 1 ? '' : 's'} will be recovered automatically.`
                : ''}
            </p>
          </div>
        </aside>
      )}

      <div className="event-intake-stats" aria-label="Candidate review totals">
        <ReviewStat icon={<Inbox />} label="pending review cards" value={pendingSummary.actionableReviewUnits} />
        <ReviewStat icon={<CheckCircle />} label="pending records in window" value={pendingSummary.inWindowPendingCandidates} />
        <ReviewStat icon={<ExclamationTriangle />} label="pending outside window" value={pendingSummary.outsideWindowPendingCandidates} />
        <ReviewStat icon={<Check2All />} label="total pending backlog" value={pendingSummary.totalPendingCandidates} />
      </div>

      <section className="mb-panel event-review-controls" aria-labelledby="review-controls-title">
        <div className="event-review-controls-heading">
          <div>
            <span className="eyebrow">Review queue</span>
            <h2 id="review-controls-title">Choose what to inspect</h2>
            <p>
              {pendingSummary.outsideWindowPendingCandidates} pending dated source records beyond the rolling two-month window are hidden from today’s queue. {blockedUnits.length} in-window cards currently need correction or duplicate review.
            </p>
          </div>
          <div className="event-review-approve-all">
            <span>
              {eligibleUnits.length} reviewable cards · {approveAllUnitCount} ready to approve · {clearableUnitCount} clearable in the current filters
            </span>
            <div className="event-review-bulk-actions">
              <button
                type="button"
                className="btn btn-match"
                disabled={approvingAll || clearingAll || clearingOutside || approveAllCandidateIds.length === 0}
                onClick={handleApproveAll}
              >
                <Check2All aria-hidden="true" />
                {approvingAll ? 'Approving…' : 'Approve all'}
              </button>
              <button
                type="button"
                className="btn btn-soft-primary"
                disabled={approvingAll || clearingAll || clearingOutside || clearableCandidateIds.length === 0}
                onClick={handleClearCurrentScope}
              >
                <X aria-hidden="true" />
                {clearingAll ? 'Clearing…' : 'Clear filtered'}
              </button>
              {outsideWindowCandidateIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-soft-primary"
                  disabled={approvingAll || clearingAll || clearingOutside}
                  onClick={handleClearOutsideWindow}
                >
                  <X aria-hidden="true" />
                  {clearingOutside
                    ? 'Clearing future backlog…'
                    : `Clear ${outsideWindowCandidateIds.length} outside-window`}
                </button>
              )}
              {clearedOutsideWindowCandidateIds.length > 0 && (
                <button
                  type="button"
                  className="btn btn-soft-primary"
                  disabled={reopeningOutside || clearingOutside}
                  onClick={handleReopenOutsideWindow}
                >
                  <ArrowRepeat aria-hidden="true" />
                  {reopeningOutside
                    ? 'Restoring future backlog…'
                    : `Restore ${clearedOutsideWindowCandidateIds.length} outside-window`}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="event-review-filters">
          <div>
            <label htmlFor="event-review-search">Search</label>
            <input
              id="event-review-search"
              type="search"
              value={searchText}
              placeholder="Name or location"
              onChange={updateFilter(setSearchText)}
            />
          </div>
          <div>
            <label htmlFor="event-review-status">Status</label>
            <select id="event-review-status" value={statusFilter} onChange={updateFilter(setStatusFilter)}>
              <option value="PENDING">Pending review</option>
              <option value="APPROVING">Approval in progress</option>
              <option value="NEEDS_PUBLICATION_REPAIR">Needs publication retry</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Cleared / skipped</option>
              <option value="SUPERSEDED">Superseded</option>
              <option value="ALL">All statuses</option>
            </select>
          </div>
          <div>
            <label htmlFor="event-review-source">Source</label>
            <select id="event-review-source" value={sourceFilter} onChange={updateFilter(setSourceFilter)}>
              <option value="ALL">All sources</option>
              {sources.map(source => (
                <option key={documentKey(source)} value={documentKey(source)}>{sourceName(source)}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="event-review-kind">Type</label>
            <select id="event-review-kind" value={kindFilter} onChange={updateFilter(setKindFilter)}>
              <option value="ALL">Events and groups</option>
              <option value="event">Events</option>
              <option value="group">Groups</option>
            </select>
          </div>
        </div>
      </section>

      {notice && (
        <div
          className={`event-intake-notice event-intake-notice--${notice.tone}`}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          aria-live={notice.tone === 'danger' ? 'assertive' : 'polite'}
        >
          {notice.message}
        </div>
      )}
      {previewError && (
        <div className="event-intake-notice event-intake-notice--danger" role="alert">
          {previewError} Approval still performs the authoritative duplicate check.
        </div>
      )}

      {reviewModel.units.length === 0 ? (
        <div className="mb-empty event-review-empty">
          <h2>No upcoming review cards match these filters.</h2>
          <p>Change a filter or run a registered source from Event intake.</p>
        </div>
      ) : (
        <div className="event-review-list">
          {displayedUnits.map(unit => {
            const representative = unit.candidates[0];
            const source = sourceById.get(documentKey(representative));
            const blockReason = unitApprovalBlock(unit, sourceById, sandboxEnabled, previews);
            const fields = effectiveReviewFields(representative);
            const location = candidateLocation(representative);
            const sourceUrl = safeReviewSourceUrl(representative, source);
            const parentCandidate = representative.parentSourceItemKey
              ? candidateByIdentity.get(`${documentKey(representative)}\u0000${representative.parentSourceItemKey}`)
              : null;
            const parentGroup = parentCandidate
              ? candidateTitle(parentCandidate)
              : fallbackParentLabel(representative.parentSourceItemKey);
            const isBusy = busyIds.includes(unit.id);
            const clearableCount = unit.candidates
              .filter(candidate => candidate.reviewStatus === 'PENDING').length;
            const reopenableCount = unit.candidates
              .filter(candidate => candidate.reviewStatus === 'REJECTED').length;
            const clearButtonLabel = clearableCount > 1
              ? `Clear / skip series (${clearableCount} source records)`
              : 'Clear / skip';
            const titleId = `candidate-title-${representative._id}`;
            const displayStatus = candidateDisplayStatus(representative);
            const classification = selectionForUnit(unit);
            const supportCandidate = documentKey(representative).startsWith('SEN-');
            const topicKeys = supportCandidate
              ? ['support']
              : INGESTION_TOPIC_KEYS.filter(topicKey => topicKey !== 'support');
            const duplicateLevel = duplicateLevelForUnit(unit, previews);
            const duplicates = safeDuplicateMatches(unit, previews);
            const previewErrorCode = previewErrorForUnit(unit, previews);
            const projection = projectionSummaryForUnit(unit, previews);
            const projectedCount = projection.projectedRecordCount;
            const repeatedProjection = projectedCount > 1 || unit.candidates.length > 1;
            const research = currentResearchFor(representative);
            const researchSuggestions = Array.isArray(research?.fieldSuggestions)
              ? research.fieldSuggestions.filter(suggestion => (
                EDITABLE_RESEARCH_FIELDS.has(suggestion.field)
              ))
              : [];
            const researchSearchUrl = safeExternalResearchUrl(research?.searchFallback?.href);
            const researchBusy = researchBusyIds.includes(String(representative._id))
              || researchInProgress(research);
            const researchAvailable = canResearchCandidate(representative, previewErrorCode);
            const researchQueue = research?.queue || {};
            const researchOffline = researchInProgress(research) && !workerOnline;
            const researchRecovering = researchLeaseExpired(research);
            const researchEvidence = Array.isArray(research?.evidence)
              ? research.evidence.map(evidence => ({
                ...evidence,
                safeUrl: safeExternalResearchUrl(evidence.sourceUrl),
              }))
              : [];
            const reviewContext = safeReviewContextFor(representative);
            const classificationReasons = classificationReasonsFor(representative);
            const isEditing = editingUnitId === unit.id && editorDraft;
            const editAvailable = representative.reviewStatus === 'PENDING'
              && Boolean(
                representative.editorialEditToken
                || previewForCandidate(previews, representative._id)?.editorialEditToken,
              );
            const capturedCandidate = representative.editorialOverrides
              ? { ...representative, editorialOverrides: undefined }
              : representative;
            const policyBlockReason = unit.candidates.map(candidate => (
              approvalBlock(candidate, sourceById.get(documentKey(candidate)), sandboxEnabled)
            )).find(Boolean);
            const duplicateOverrideAvailable = sandboxEnabled
              && !policyBlockReason
              && unit.candidates.length === 1
              && duplicateLevel === 'BLOCK';
            const categoryLocked = representative.reviewStatus !== 'PENDING';
            let footerCopy = repeatedProjection
              ? `One approval publishes ${projectedCount} dates in this repeated series.`
              : 'Approval creates or updates the public record.';
            if (duplicateLevel === 'REVIEW') {
              footerCopy = unit.candidates.length > 1
                ? 'Possible matches are shown above. Series approval skips those dates and checks the rest.'
                : 'Possible match found. Compare it above and explicitly confirm before publishing.';
            } else if (duplicateLevel === 'BLOCK' && unit.candidates.length > 1) {
              footerCopy = 'Some dates already appear to exist. Series approval will skip those duplicates and check the rest.';
            }
            const buttonLabel = repeatedProjection
              ? `Approve series (${projectedCount})`
              : approvalActionLabel(representative, false);
            return (
              <article className="mb-panel event-review-card" key={unit.id} aria-labelledby={titleId}>
                <header className="event-review-card-head">
                  <div>
                    <span className="eyebrow">
                      {sourceName(source)} · {repeatedProjection ? 'Repeated event' : humanizeToken(candidateKind(representative))}
                    </span>
                    <h2 id={titleId}>{candidateTitle(representative)}</h2>
                  </div>
                  <Status tone={statusTone(displayStatus)}>{humanizeToken(displayStatus)}</Status>
                </header>

                <dl className="event-review-details">
                  <div>
                    <dt>Schedule</dt>
                    <dd>{unitSchedule(unit) || 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt>Location</dt>
                    <dd>{location || 'Not recorded'}</dd>
                  </div>
                  <div className="event-review-category-field">
                    <dt>Category</dt>
                    <dd>
                      <select
                        aria-label={`Category for ${candidateTitle(representative)}`}
                        value={classification.topicKey}
                        disabled={categoryLocked}
                        onChange={event => setUnitTopic(unit, event.target.value)}
                      >
                        {topicKeys.map(topicKey => (
                          <option key={topicKey} value={topicKey}>{INGESTION_REVIEW_TAXONOMY[topicKey].label}</option>
                        ))}
                      </select>
                    </dd>
                  </div>
                  <div className="event-review-category-field">
                    <dt>Subcategory</dt>
                    <dd>
                      <select
                        aria-label={`Subcategory for ${candidateTitle(representative)}`}
                        value={classification.subcategoryKey}
                        disabled={categoryLocked}
                        onChange={event => setUnitSubcategory(unit, event.target.value)}
                      >
                        {subcategoryOptionsFor(classification.topicKey).map(option => (
                          <option key={option.key} value={option.key}>{option.label}</option>
                        ))}
                      </select>
                      {Number.isFinite(classification.confidence) && (
                        <small>{Math.round(classification.confidence * 100)}% automatic match</small>
                      )}
                    </dd>
                  </div>
                  {candidateKind(representative) === 'event' && representative.parentSourceItemKey && (
                    <div>
                      <dt>Parent group</dt>
                      <dd>{parentGroup || 'Not recorded'}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Observed</dt>
                    <dd>{formatDateTime(representative.lastObservedAt || representative.createdAt) || 'Not recorded'}</dd>
                  </div>
                  <div>
                    <dt>Official source</dt>
                    <dd>{sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer">View source page</a> : 'Not recorded'}</dd>
                  </div>
                </dl>

                {(reviewContext || classificationReasons.length > 0) && (
                  <section className="event-review-source-context" aria-label="Source context and category reasoning">
                    <div className="event-review-source-context-heading">
                      <div>
                        <span className="eyebrow">Source context</span>
                        <h3>What MatchBook understood</h3>
                      </div>
                      {reviewContext?.researchNeeded.length > 0 && (
                        <Status tone="pending">Follow-up needed</Status>
                      )}
                    </div>
                    {reviewContext?.description && (
                      <p className="event-review-source-description">{reviewContext.description}</p>
                    )}
                    <dl className="event-review-source-context-grid">
                      {reviewContext?.context && (
                        <div>
                          <dt>Helpful context</dt>
                          <dd>{reviewContext.context}</dd>
                        </div>
                      )}
                      {reviewContext?.locationHint && (
                        <div>
                          <dt>Location clue to verify</dt>
                          <dd>{reviewContext.locationHint}</dd>
                        </div>
                      )}
                      {reviewContext?.researchNeeded.length > 0 && (
                        <div>
                          <dt>Automatic follow-up</dt>
                          <dd>{reviewContext.researchNeeded.map(humanizeToken).join(', ')}</dd>
                        </div>
                      )}
                      {classificationReasons.length > 0 && (
                        <div>
                          <dt>Why this category</dt>
                          <dd>{classificationReasons.join('; ')}</dd>
                        </div>
                      )}
                    </dl>
                    {reviewContext?.locationHint && (
                      <p className="event-review-source-note">
                        Location clues stay review-only until a curator verifies and saves them.
                      </p>
                    )}
                  </section>
                )}

                {isEditing && (
                  <form
                    className="event-review-editor"
                    onSubmit={event => {
                      event.preventDefault();
                      saveEditorialChanges(unit);
                    }}
                  >
                    <div className="event-review-editor-heading">
                      <div>
                        <span className="eyebrow">Curator correction</span>
                        <h3>Edit the details used for publication</h3>
                      </div>
                      <button
                        type="button"
                        className="btn btn-link"
                        disabled={savingEdit}
                        onClick={closeEditor}
                      >
                        <X aria-hidden="true" />
                        Cancel
                      </button>
                    </div>
                    {unit.candidates.length > 1 && (
                      <p className="event-review-editor-note">
                        This correction applies only to the first occurrence shown on this card. Its series will be regrouped from the reviewed facts.
                      </p>
                    )}
                    <div className="event-review-editor-source">
                      <strong>Captured source values</strong>
                      <span>Name: {candidateTitle(capturedCandidate)}</span>
                      <span>Location: {candidateLocation(capturedCandidate) || 'Not recorded'}</span>
                      <span>Schedule: {candidateSchedule(capturedCandidate) || 'Not recorded'}</span>
                    </div>
                    <div className="event-review-editor-grid">
                      <div>
                        <label htmlFor={`candidate-title-edit-${representative._id}`}>Event or group name</label>
                        <input
                          id={`candidate-title-edit-${representative._id}`}
                          type="text"
                          maxLength="300"
                          value={editorDraft.title}
                          onChange={updateEditor('title')}
                        />
                      </div>
                      <div>
                        <label htmlFor={`candidate-location-edit-${representative._id}`}>Location</label>
                        <input
                          id={`candidate-location-edit-${representative._id}`}
                          type="text"
                          maxLength="300"
                          placeholder="Venue and public address"
                          value={editorDraft.location}
                          onChange={updateEditor('location')}
                        />
                      </div>
                      <div>
                        <label htmlFor={`candidate-schedule-kind-${representative._id}`}>Schedule type</label>
                        <select
                          id={`candidate-schedule-kind-${representative._id}`}
                          value={editorDraft.scheduleKind}
                          onChange={updateEditor('scheduleKind')}
                        >
                          <option value="NONE">Not recorded</option>
                          {candidateKind(representative) === 'event' && (
                            <option value="ONE_TIME">One date</option>
                          )}
                          <option value="RECURRENCE">Repeating schedule</option>
                        </select>
                      </div>
                      {editorDraft.scheduleKind === 'ONE_TIME' && (
                        <>
                          <div>
                            <label htmlFor={`candidate-start-edit-${representative._id}`}>Starts in Hawaiʻi time</label>
                            <input
                              id={`candidate-start-edit-${representative._id}`}
                              type="datetime-local"
                              value={editorDraft.localStart}
                              onChange={updateEditor('localStart')}
                            />
                          </div>
                          <div>
                            <label htmlFor={`candidate-end-edit-${representative._id}`}>Ends in Hawaiʻi time (optional)</label>
                            <input
                              id={`candidate-end-edit-${representative._id}`}
                              type="datetime-local"
                              value={editorDraft.localEnd}
                              onChange={updateEditor('localEnd')}
                            />
                          </div>
                        </>
                      )}
                      {editorDraft.scheduleKind === 'RECURRENCE' && (
                        <div className="event-review-editor-wide">
                          <label htmlFor={`candidate-recurrence-edit-${representative._id}`}>Repeating schedule</label>
                          <input
                            id={`candidate-recurrence-edit-${representative._id}`}
                            type="text"
                            maxLength="200"
                            placeholder="For example: Every Tuesday, 1:30 pm–3:00 pm"
                            value={editorDraft.recurrenceLabel}
                            onChange={updateEditor('recurrenceLabel')}
                          />
                        </div>
                      )}
                    </div>
                    <div className="event-review-editor-actions">
                      <span>Saved corrections are audited and never overwrite the captured source evidence.</span>
                      <button type="submit" className="btn btn-match" disabled={savingEdit}>
                        <Save aria-hidden="true" />
                        {savingEdit ? 'Saving…' : 'Save reviewed details'}
                      </button>
                    </div>
                  </form>
                )}

                {research && (
                  <aside className="event-review-research" aria-label="Missing detail research">
                    <div className="event-review-research-heading">
                      <div>
                        <span className="eyebrow">Find missing details</span>
                        <strong>{humanizeToken(research.status)}</strong>
                      </div>
                      <Status tone={statusTone(research.status)}>{humanizeToken(research.status)}</Status>
                    </div>
                    {researchQueue.progressMessage && (
                      <p className="event-review-research-progress">
                        {researchQueue.progressMessage}
                      </p>
                    )}
                    {researchOffline && (
                      <p className="event-review-research-warning">
                        This search is stored safely, but no research worker is online. It will resume automatically when the worker returns.
                      </p>
                    )}
                    {researchRecovering && (
                      <p className="event-review-research-warning">
                        The previous worker lease expired. Another worker can recover this search without creating a duplicate request.
                      </p>
                    )}
                    <dl className="event-review-research-meta">
                      {Number.isInteger(researchQueue.attemptCount) && (
                        <div>
                          <dt>Queue attempt</dt>
                          <dd>
                            {researchQueue.attemptCount} of {researchQueue.maxAttempts || 3}
                          </dd>
                        </div>
                      )}
                      {research.requestedAt && (
                        <div>
                          <dt>Queued</dt>
                          <dd>{formatDateTime(research.requestedAt)}</dd>
                        </div>
                      )}
                      {researchQueue.nextAttemptAt && (
                        <div>
                          <dt>Automatic retry</dt>
                          <dd>{formatDateTime(researchQueue.nextAttemptAt)}</dd>
                        </div>
                      )}
                      {(researchQueue.updatedAt || research.updatedAt) && (
                        <div>
                          <dt>Last update</dt>
                          <dd>{formatDateTime(researchQueue.updatedAt || research.updatedAt)}</dd>
                        </div>
                      )}
                    </dl>
                    {Array.isArray(research.missingFields) && research.missingFields.length > 0 && (
                      <p className="event-review-research-missing">
                        <strong>Still needed:</strong>{' '}
                        {research.missingFields.map(humanizeToken).join(', ')}
                      </p>
                    )}
                    {Array.isArray(research.attempts) && research.attempts.length > 0 && (
                      <ol className="event-review-research-attempts">
                        {research.attempts.map((attempt, index) => (
                          <li key={`${attempt.strategy}-${index}`}>
                            <span>{humanizeToken(attempt.strategy)}: {humanizeToken(attempt.status)}</span>
                            {attempt.code && <small>{humanizeToken(attempt.code)}</small>}
                            {(attempt.finishedAt || attempt.startedAt) && (
                              <small>{formatDateTime(attempt.finishedAt || attempt.startedAt)}</small>
                            )}
                          </li>
                        ))}
                      </ol>
                    )}
                    {researchEvidence.length > 0 && (
                      <div className="event-review-research-evidence">
                        <strong>Evidence checked</strong>
                        <ul>
                          {researchEvidence.map(evidence => (
                            <li key={evidence.id}>
                              {evidence.safeUrl ? (
                                <a href={evidence.safeUrl} target="_blank" rel="noreferrer">
                                  {humanizeToken(evidence.kind)}
                                </a>
                              ) : humanizeToken(evidence.kind)}
                              {Array.isArray(evidence.fields) && evidence.fields.length > 0 && (
                                <small>Fields: {evidence.fields.map(humanizeToken).join(', ')}</small>
                              )}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(research.errorCode || researchQueue.lastErrorCode) && (
                      <p className="event-review-research-error">
                        Last research error: {humanizeToken(research.errorCode || researchQueue.lastErrorCode)}
                      </p>
                    )}
                    {researchSuggestions.length > 0 && (
                      <div className="event-review-research-suggestions">
                        <strong>Suggested corrections</strong>
                        <ul>
                          {researchSuggestions.map(suggestion => (
                            <li key={`${suggestion.field}-${suggestion.value}`}>
                              <span>{humanizeToken(suggestion.field)}</span>
                              <b>{String(suggestion.value)}</b>
                              {Number.isFinite(suggestion.confidence) && (
                                <small>{Math.round(suggestion.confidence * 100)}% confidence</small>
                              )}
                            </li>
                          ))}
                        </ul>
                        <button
                          type="button"
                          className="btn btn-soft-primary"
                          disabled={!editAvailable || savingEdit}
                          onClick={() => startEditing(unit, researchSuggestions)}
                        >
                          <PencilSquare aria-hidden="true" />
                          Review these suggestions
                        </button>
                      </div>
                    )}
                    {researchSearchUrl && research.searchFallback?.availability === 'AVAILABLE' && (
                      <a
                        className="btn btn-link event-review-search-fallback"
                        href={researchSearchUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Search aria-hidden="true" />
                        Open the manual web-search fallback
                      </a>
                    )}
                  </aside>
                )}

                <div className="event-review-tags" aria-label="Review checks">
                  {representative.reviewLane === 'SENSITIVE' && <span>Sensitive review</span>}
                  {representative.editorialRevision > 0 && (
                    <span>Curator correction v{representative.editorialRevision}</span>
                  )}
                  {repeatedProjection && projectedCount !== null && (
                    <span>{projectedCount} public event dates</span>
                  )}
                  {projection.projectedFirstDate && projection.projectedLastDate && (
                    <span>
                      {formatDateOnly(projection.projectedFirstDate)} – {formatDateOnly(projection.projectedLastDate)}
                    </span>
                  )}
                  {!previewErrorCode && duplicateLevel === 'NONE' && <span>No close duplicate in sample</span>}
                  {duplicateLevel === 'PENDING' && <span>Checking duplicates…</span>}
                  {duplicateLevel === 'REVIEW' && <span>Possible duplicate — compare</span>}
                  {duplicateLevel === 'BLOCK' && <span>Likely duplicate — blocked</span>}
                  {previewErrorCode && <span>Publication data needs correction</span>}
                  {(fields.reviewFlags || []).map(flag => <span key={flag}>{humanizeToken(flag)}</span>)}
                </div>

                {duplicates.length > 0 && (
                  <div className="event-review-duplicate-box">
                    <strong>Similar listing already on MatchBook</strong>
                    <ul>
                      {duplicates.map(match => (
                        <li key={String(match.id || match._id || `${match.title}-${match.date}`)}>
                          {match.title || 'Untitled event'}
                          {match.date ? ` · ${formatDateTime(match.date)}` : ''}
                          {match.meetingTime ? ` · ${match.meetingTime}` : ''}
                          {match.location ? ` · ${match.location}` : ''}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {representative.lastProjectionErrorCode && (
                  <p className="event-review-error">Last publication attempt: {humanizeToken(representative.lastProjectionErrorCode)}</p>
                )}

                <footer className="event-review-card-footer">
                  <p className={blockReason ? 'event-review-blocked' : undefined}>
                    {blockReason && <ExclamationTriangle aria-hidden="true" />}
                    {blockReason || footerCopy}
                  </p>
                  <div className="event-review-card-actions">
                    {clearableCount > 0 && (
                      <button
                        type="button"
                        className="btn btn-soft-primary"
                        disabled={isBusy || approvingAll || clearingAll || clearingOutside || Boolean(isEditing)}
                        onClick={() => handleClearUnit(unit)}
                      >
                        <X aria-hidden="true" />
                        {isBusy ? 'Updating…' : clearButtonLabel}
                      </button>
                    )}
                    {reopenableCount > 0 && clearableCount === 0 && (
                      <button
                        type="button"
                        className="btn btn-soft-primary"
                        disabled={isBusy || clearingAll || clearingOutside}
                        onClick={() => handleReopenUnit(unit)}
                      >
                        <ArrowRepeat aria-hidden="true" />
                        {isBusy ? 'Restoring…' : `Restore${reopenableCount > 1 ? ` series (${reopenableCount})` : ''}`}
                      </button>
                    )}
                    {researchAvailable && (
                      <button
                        type="button"
                        className="btn btn-soft-primary"
                        disabled={researchBusy || savingEdit || approvingAll || clearingAll || clearingOutside}
                        onClick={() => requestMissingDetails(representative)}
                      >
                        {researchBusy ? <ArrowRepeat aria-hidden="true" /> : <Search aria-hidden="true" />}
                        {researchActionLabel(research)}
                      </button>
                    )}
                    {editAvailable && !isEditing && (
                      <button
                        type="button"
                        className="btn btn-soft-primary"
                        disabled={savingEdit || approvingAll || clearingAll || clearingOutside}
                        onClick={() => startEditing(unit)}
                      >
                        <PencilSquare aria-hidden="true" />
                        {unit.candidates.length > 1 ? 'Edit this occurrence' : 'Edit details'}
                      </button>
                    )}
                    {!duplicateOverrideAvailable && (
                      <button
                        type="button"
                        className="btn btn-match"
                        disabled={Boolean(blockReason) || isBusy || approvingAll || clearingAll || clearingOutside || Boolean(isEditing)}
                        onClick={() => handleApprove(unit)}
                      >
                        <CheckCircle aria-hidden="true" />
                        {isBusy ? 'Approving…' : buttonLabel}
                      </button>
                    )}
                    {duplicateOverrideAvailable && (
                      <button
                        type="button"
                        className="btn btn-soft-primary"
                        disabled={isBusy || approvingAll || clearingAll || clearingOutside || Boolean(isEditing)}
                        onClick={() => handleDuplicateOverride(unit)}
                      >
                        Override duplicate in sandbox
                      </button>
                    )}
                  </div>
                </footer>
              </article>
            );
          })}
          {remainingUnits > 0 && (
            <button
              type="button"
              className="btn btn-soft-primary event-review-load-more"
              onClick={() => setVisibleLimit(current => current + 30)}
            >
              Load 30 more ({remainingUnits} remaining)
            </button>
          )}
        </div>
      )}
    </Container>
  );
};

export default EventReview;
