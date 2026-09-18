import React, { useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import swal from 'sweetalert';
import {
  ArrowLeft,
  ArrowClockwise,
  CheckCircle,
  ClipboardCheck,
  ClockHistory,
  Database,
  Inbox,
  PlayFill,
  ShieldLock,
} from '../utilities/icons';
import {
  CommunitySources,
  INGESTION_PUBLICATIONS,
  IngestionCandidates,
  SourceHealth,
  SourceRuns,
} from '../../api/ingestion/IngestionData';
import {
  INGESTION_RECENT_POLICY,
  INGESTION_RECENT_WINDOW_MS,
  INGESTION_RUN_REQUEST_METHODS,
  INGESTION_RUN_REQUEST_PUBLICATION,
  INGESTION_RUN_REQUEST_STATUS,
  IngestionRunRequests,
} from '../../api/ingestion/IngestionRunRequests';
import LoadingSpinner from '../components/LoadingSpinner';
import PageHead from '../components/PageHead';
import { pendingReviewQueueSummary } from './EventReviewModel';
import './EventIntake.css';

const TOKEN_LABELS = {
  AUTOMATED_ALLOWED: 'Automation approved',
  MANUAL_ONLY: 'Manual collection only',
  MANUAL_CLIP: 'Protected manual snapshot',
  PROBE_REQUIRED: 'Permission review needed',
  SYNTHETIC_FIXTURE: 'Fixture',
  TRIBE_REST: 'Events API',
  WP_FILTERED_TRIBE: 'Filtered events API',
  STATIC_JSON: 'Published data file',
  ICS: 'Calendar feed',
  COUNTY_OPENCITIES: 'County calendar',
  JSON_LD_HTML: 'Structured web page',
  SOURCE_HTML: 'Source web page',
  JSON_API: 'JSON API',
  ICS_FEED: 'Calendar feed',
  HTML_LIST: 'Web page list',
  HTML_DETAIL: 'Web page detail',
  PDF_MONITOR: 'Document monitor',
  HEALTHY: 'Healthy',
  SUCCESS: 'Succeeded',
  SUCCEEDED: 'Succeeded',
  FAILED: 'Failed',
  RUNNING: 'Running',
  QUEUED: 'Queued',
  SKIPPED_RECENT: 'Skipped (recent)',
  ALREADY_RUNNING: 'Already running',
  COMPLETE: 'Complete',
  PARTIAL: 'Partial',
  NOT_RUN: 'Not run',
  PENDING: 'Pending review',
  SUPERSEDED: 'Superseded',
  VALID: 'Checks passed',
  INVALID: 'Needs attention',
};

const humanizeToken = value => {
  if (!value) return 'Not recorded';
  if (TOKEN_LABELS[value]) return TOKEN_LABELS[value];
  const words = String(value).replaceAll('_', ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const formatDate = value => {
  if (!value) return 'Not yet';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Pacific/Honolulu',
  }).format(date);
};

const formatDateTime = value => {
  if (!value) return 'Not yet';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Not recorded';
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

const documentKey = document => String(document.sourceId || document.id || document._id || 'unknown');

const sourceName = source => source.displayName || source.name || source.slug || documentKey(source);

const sourceSteward = source => {
  if (source.stewardName) return source.stewardName;
  if (typeof source.steward === 'string' && source.steward.trim().toLowerCase() !== 'unassigned') return source.steward;
  if (source.steward && source.steward.name) return source.steward.name;
  return 'Unassigned';
};

const isApproved = source => source.permission === 'AUTOMATED_ALLOWED';

const sourceReadiness = source => {
  if (source.permission === 'MANUAL_ONLY') return 'Protected manual review';
  if (!isApproved(source)) return 'Needs permission review';
  if (!source.enabled) return 'Approved, paused';
  return 'Ready for scheduled runs';
};

const statusTone = value => {
  const normalized = String(value || '').toUpperCase();
  if (normalized.includes('FAIL') || normalized.includes('ERROR') || normalized.includes('INVALID')) return 'danger';
  if (normalized.includes('SUCCESS') || normalized.includes('HEALTHY') || normalized.includes('READY') || normalized.includes('ALLOWED') || normalized.includes('COMPLETE')) return 'positive';
  return 'pending';
};

const ACTIVE_REQUEST_STATUSES = new Set([
  INGESTION_RUN_REQUEST_STATUS.queued,
  INGESTION_RUN_REQUEST_STATUS.running,
]);

const isRecentAttempt = health => {
  if (!health?.lastAttemptAt) return false;
  const lastAttempt = health.lastAttemptAt instanceof Date
    ? health.lastAttemptAt
    : new Date(health.lastAttemptAt);
  return !Number.isNaN(lastAttempt.getTime())
    && lastAttempt.getTime() >= Date.now() - INGESTION_RECENT_WINDOW_MS;
};

const Stat = ({ detail, icon, label, value }) => (
  <div className="mb-panel event-intake-stat">
    <span className="event-intake-stat-icon" aria-hidden="true">{icon}</span>
    <strong>{value}</strong>
    <span>{label}</span>
    {detail && <small>{detail}</small>}
  </div>
);

Stat.propTypes = {
  detail: PropTypes.string,
  icon: PropTypes.node.isRequired,
  label: PropTypes.string.isRequired,
  value: PropTypes.number.isRequired,
};

Stat.defaultProps = {
  detail: null,
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

const candidateTitle = candidate => {
  if (candidate.summary && typeof candidate.summary === 'string') return candidate.summary;
  if (candidate.summary && candidate.summary.title) return candidate.summary.title;
  return candidate.title || 'Untitled intake candidate';
};

const healthDetail = health => {
  if (!health) return 'No run recorded';
  if (health.lastStatus === 'PARTIAL' && health.consecutiveFailures > 0) {
    const noun = health.consecutiveFailures === 1 ? 'run' : 'runs';
    return `${health.consecutiveFailures} consecutive partial ${noun}`;
  }
  if (health.consecutiveFailures > 0) {
    const noun = health.consecutiveFailures === 1 ? 'failure' : 'failures';
    return `${health.consecutiveFailures} consecutive ${noun}`;
  }
  if (health.lastAttemptAt) return `Last attempt ${formatDateTime(health.lastAttemptAt)}`;
  if (health.lastSuccessAt) return `Last success ${formatDateTime(health.lastSuccessAt)}`;
  return 'No run recorded';
};

const requestNotice = result => {
  const totals = result?.totals || {};
  const parts = [];
  if (totals.queued) parts.push(`${totals.queued} queued`);
  if (totals.skippedRecent) parts.push(`${totals.skippedRecent} skipped because they ran recently`);
  if (totals.alreadyRunning) parts.push(`${totals.alreadyRunning} already running`);
  return parts.length ? parts.join(', ') : 'No collection request was added.';
};

const runButtonLabel = (isRequesting, isActive) => {
  if (isRequesting) return 'Requesting…';
  if (isActive) return 'In progress';
  return 'Run';
};

const EventIntake = () => {
  const [requestingAll, setRequestingAll] = useState(false);
  const [requestingSources, setRequestingSources] = useState([]);
  const [notice, setNotice] = useState(null);
  const { candidates, health, ready, requests, runs, sources } = useTracker(() => {
    const sourceSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.sources);
    const runSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.runs);
    const candidateSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.candidates);
    const healthSubscription = Meteor.subscribe(INGESTION_PUBLICATIONS.health);
    const requestSubscription = Meteor.subscribe(INGESTION_RUN_REQUEST_PUBLICATION);

    return {
      sources: CommunitySources.find({}, { sort: { displayName: 1, slug: 1 } }).fetch(),
      runs: SourceRuns.find({}, { sort: { startedAt: -1, createdAt: -1 }, limit: 20 }).fetch(),
      candidates: IngestionCandidates.find({}, { sort: { createdAt: -1 }, limit: 5000 }).fetch(),
      health: SourceHealth.find({}).fetch(),
      requests: IngestionRunRequests.find({}, { sort: { requestedAt: -1 }, limit: 500 }).fetch(),
      ready: sourceSubscription.ready()
        && runSubscription.ready()
        && candidateSubscription.ready()
        && healthSubscription.ready()
        && requestSubscription.ready(),
    };
  }, []);

  if (!ready) return <LoadingSpinner />;

  const approvedCount = sources.filter(isApproved).length;
  const pendingSummary = pendingReviewQueueSummary(candidates);
  const healthBySource = new Map(health.map(item => [documentKey(item), item]));
  const latestRequestBySource = new Map();
  requests.forEach(request => {
    const key = documentKey(request);
    if (!latestRequestBySource.has(key)) latestRequestBySource.set(key, request);
  });

  const callRunMethod = ({ method, args, sourceId }) => {
    if (sourceId) {
      setRequestingSources(current => [...new Set([...current, sourceId])]);
    } else {
      setRequestingAll(true);
    }
    setNotice({ tone: 'pending', message: 'Submitting the collection request…' });
    Meteor.call(method, ...args, (error, result) => {
      if (sourceId) {
        setRequestingSources(current => current.filter(id => id !== sourceId));
      } else {
        setRequestingAll(false);
      }
      if (error) {
        const message = error.reason || error.message || 'The collection request could not be submitted.';
        setNotice({ tone: 'danger', message });
        swal('Could not start collection', message, 'error');
        return;
      }
      const message = requestNotice(result);
      setNotice({ tone: 'positive', message: `Request accepted: ${message}.` });
    });
  };

  const chooseRecentPolicy = async ({ count, name }) => {
    if (count === 0) return INGESTION_RECENT_POLICY.skip;
    const single = count === 1 && name;
    return swal({
      title: single ? `Run ${name} again?` : `${count} sources ran in the last day`,
      text: single
        ? 'This source was attempted within the last 24 hours. Choose No to record a skip, or Yes to run it again.'
        : 'Choose No to skip only those recent sources and run the rest. Choose Yes to run every source again.',
      icon: 'warning',
      buttons: {
        skip: {
          text: single ? 'No, skip it' : 'No, skip recent',
          value: INGESTION_RECENT_POLICY.skip,
          visible: true,
        },
        rerun: {
          text: 'Yes, run again',
          value: INGESTION_RECENT_POLICY.rerun,
          visible: true,
        },
      },
    });
  };

  const handleRunSource = async source => {
    const sourceId = documentKey(source);
    const sourceHealth = healthBySource.get(sourceId);
    const recentPolicy = await chooseRecentPolicy({
      count: isRecentAttempt(sourceHealth) ? 1 : 0,
      name: sourceName(source),
    });
    if (!recentPolicy) return;
    callRunMethod({
      method: INGESTION_RUN_REQUEST_METHODS.requestSource,
      args: [sourceId, recentPolicy],
      sourceId,
    });
  };

  const handleRunAll = async () => {
    const recentCount = sources.filter(source => (
      isRecentAttempt(healthBySource.get(documentKey(source)))
    )).length;
    const recentPolicy = await chooseRecentPolicy({ count: recentCount });
    if (!recentPolicy) return;
    callRunMethod({
      method: INGESTION_RUN_REQUEST_METHODS.requestAll,
      args: [recentPolicy],
    });
  };

  return (
    <Container id="event-intake" className="page-shell py-5">
      <PageHead
        title="Event intake"
        eyebrow="Admin"
        action={(
          <Link className="btn btn-soft-primary" to="/admin">
            <ArrowLeft aria-hidden="true" />
            Dashboard
          </Link>
        )}
      >
        Source readiness, collection runs, and event or group candidates before anything reaches the public directory.
      </PageHead>

      <aside className="event-intake-boundary" aria-labelledby="event-intake-boundary-title">
        <ShieldLock aria-hidden="true" />
        <div>
          <h2 id="event-intake-boundary-title">Publication stays human-controlled</h2>
          <p>Sources can prepare private review candidates, but they cannot publish, edit, or remove public events or groups directly.</p>
        </div>
      </aside>

      <section className="mb-panel event-intake-toolbar" aria-labelledby="event-intake-tools-title">
        <div>
          <span className="eyebrow">Collection controls</span>
          <h2 id="event-intake-tools-title">Prepare the private review queue</h2>
          <p>Run one source or request every registered source. Recent sources can be skipped without stopping the rest of the batch.</p>
        </div>
        <div className="event-intake-toolbar-actions">
          <button
            type="button"
            className="btn btn-match"
            disabled={requestingAll || sources.length === 0}
            onClick={handleRunAll}
          >
            <PlayFill aria-hidden="true" />
            {requestingAll ? 'Requesting…' : 'Run all'}
          </button>
          <Link className="btn btn-soft-primary" to="/admin/event-intake/review">
            <ClipboardCheck aria-hidden="true" />
            Review candidates{pendingSummary.actionableReviewUnits
              ? ` (${pendingSummary.actionableReviewUnits})`
              : ''}
          </Link>
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

      <div className="event-intake-stats" aria-label="Event intake totals">
        <Stat icon={<Database />} label="registered sources" value={sources.length} />
        <Stat icon={<CheckCircle />} label="approved sources" value={approvedCount} />
        <Stat icon={<ClockHistory />} label="runs shown" value={runs.length} />
        <Stat
          detail={`${pendingSummary.totalPendingCandidates} source records pending · ${pendingSummary.outsideWindowPendingCandidates} outside the two-month window`}
          icon={<Inbox />}
          label="review cards ready"
          value={pendingSummary.actionableReviewUnits}
        />
      </div>

      <section className="event-intake-section" aria-labelledby="source-readiness-title">
        <div className="event-intake-section-head">
          <div>
            <span className="eyebrow">Register</span>
            <h2 id="source-readiness-title">Source readiness</h2>
          </div>
          <p>Every source begins paused until its access, steward, and collection policy are verified.</p>
        </div>

        {sources.length === 0 ? (
          <div className="mb-empty">
            <h3>No sources registered.</h3>
            <p>Add the governed source registry before enabling collection work.</p>
          </div>
        ) : (
          <div className="event-intake-table-wrap">
            <table className="event-intake-table">
              <caption className="visually-hidden">Registered community sources and their collection readiness</caption>
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Collection</th>
                  <th scope="col">Permission</th>
                  <th scope="col">Steward</th>
                  <th scope="col">Last verified</th>
                  <th scope="col">Health</th>
                  <th scope="col">Action</th>
                </tr>
              </thead>
              <tbody>
                {sources.map(source => {
                  const sourceHealth = healthBySource.get(documentKey(source));
                  const healthValue = sourceHealth && (sourceHealth.lastStatus || sourceHealth.status || sourceHealth.lastRunStatus);
                  const readiness = sourceReadiness(source);
                  const sourceId = documentKey(source);
                  const latestRequest = latestRequestBySource.get(sourceId);
                  const isRequesting = requestingSources.includes(sourceId);
                  const isActive = ACTIVE_REQUEST_STATUSES.has(latestRequest?.status);
                  return (
                    <tr key={sourceId}>
                      <td data-label="Source">
                        <strong>
                          {source.publisherUrl ? (
                            <a href={source.publisherUrl} target="_blank" rel="noreferrer">{sourceName(source)}</a>
                          ) : sourceName(source)}
                        </strong>
                        <span>{source.tier ? `Tier ${source.tier}` : 'Tier not assigned'}</span>
                        {source.reviewLane === 'SENSITIVE' && (
                          <Status tone="pending">Sensitive review</Status>
                        )}
                      </td>
                      <td data-label="Collection">{humanizeToken(source.adapterKind)}</td>
                      <td data-label="Permission">
                        <Status tone={statusTone(readiness)}>{readiness}</Status>
                      </td>
                      <td data-label="Steward">{sourceSteward(source)}</td>
                      <td data-label="Last verified">{formatDate(source.lastVerifiedAt)}</td>
                      <td data-label="Health">
                        <Status tone={statusTone(healthValue)}>{humanizeToken(healthValue || 'NOT_RUN')}</Status>
                        <span className="event-intake-health-detail">{healthDetail(sourceHealth)}</span>
                      </td>
                      <td data-label="Action" className="event-intake-action-cell">
                        <button
                          type="button"
                          className="btn btn-sm btn-soft-primary"
                          disabled={isRequesting || isActive}
                          onClick={() => handleRunSource(source)}
                          aria-label={`Run ${sourceName(source)}`}
                        >
                          {isActive ? <ArrowClockwise aria-hidden="true" /> : <PlayFill aria-hidden="true" />}
                          {runButtonLabel(isRequesting, isActive)}
                        </button>
                        {latestRequest && (
                          <span className="event-intake-request-detail">
                            <Status tone={statusTone(latestRequest.status)}>{humanizeToken(latestRequest.status)}</Status>
                            <small>{formatDateTime(latestRequest.finishedAt || latestRequest.startedAt || latestRequest.requestedAt)}</small>
                            {latestRequest.completeness && <small>{humanizeToken(latestRequest.completeness)}</small>}
                            {Number.isInteger(latestRequest.metrics?.emitted) && (
                              <small>{latestRequest.metrics.emitted} candidates emitted</small>
                            )}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="event-intake-activity-grid">
        <section className="mb-panel event-intake-activity" aria-labelledby="recent-runs-title">
          <div className="event-intake-section-head event-intake-section-head--compact">
            <div>
              <span className="eyebrow">Observe</span>
              <h2 id="recent-runs-title">Recent collection runs</h2>
            </div>
          </div>
          {runs.length === 0 ? (
            <div className="event-intake-quiet-state">
              <p>No collection runs yet.</p>
              <span>Registered sources remain paused while permissions are reviewed.</span>
            </div>
          ) : (
            <ul className="event-intake-activity-list">
              {runs.slice(0, 6).map(run => (
                <li key={String(run._id)}>
                  <div>
                    <strong>{sourceName(sources.find(source => documentKey(source) === String(run.sourceId)) || { sourceId: run.sourceId })}</strong>
                    <span>{formatDateTime(run.finishedAt || run.startedAt || run.createdAt)}</span>
                  </div>
                  <Status tone={statusTone(run.status)}>{humanizeToken(run.status)}</Status>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mb-panel event-intake-activity" aria-labelledby="candidate-queue-title">
          <div className="event-intake-section-head event-intake-section-head--compact">
            <div>
              <span className="eyebrow">Review</span>
              <h2 id="candidate-queue-title">Candidate queue</h2>
            </div>
          </div>
          {candidates.length === 0 ? (
            <div className="event-intake-quiet-state">
              <p>No candidates waiting.</p>
              <span>New observations will appear here as candidates, never as published events or groups.</span>
            </div>
          ) : (
            <ul className="event-intake-activity-list">
              {candidates.slice(0, 6).map(candidate => (
                <li key={String(candidate._id)}>
                  <div>
                    <strong>{candidateTitle(candidate)}</strong>
                    <span>{formatDate(candidate.createdAt)}</span>
                    {candidate.reviewLane === 'SENSITIVE' && <span>Sensitive review required</span>}
                  </div>
                  <Status tone={statusTone(candidate.reviewStatus || candidate.validationState)}>
                    {humanizeToken(candidate.reviewStatus || candidate.validationState)}
                  </Status>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Container>
  );
};

export default EventIntake;
