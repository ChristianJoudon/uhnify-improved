import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Meteor } from 'meteor/meteor';
import { useTracker } from 'meteor/react-meteor-data';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';
import SituationReport, { briefingSections } from '../components/SituationReport';
import { EmergencyState, HelpBriefing, HelpBriefingItems, HelpResources, RESOURCE_KINDS } from '../../api/help/Help';
import { formatShortDate } from '../utilities/helpers';

/**
 * Where to find help. Public, and deliberately plain: no map tiles, no
 * photos, nothing that a phone on one bar after a storm has to wait for. A
 * list by kind — water first, because that is the question — with where,
 * when, whether it is open, who says so, when somebody last checked, and a
 * way to get directions from whatever maps the phone has.
 */
const directionsTo = place => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${place}, Kauai, HI`)}`;

const STATUS = {
  open: { label: 'Open', className: 'help-status help-status--open' },
  closed: { label: 'Closed', className: 'help-status help-status--closed' },
  unknown: { label: 'Not confirmed', className: 'help-status' },
};

const Resource = ({ resource }) => {
  const status = STATUS[resource.status] || STATUS.unknown;
  return (
    <li className="help-resource">
      <div className="help-resource-head">
        <strong>{resource.name}</strong>
        <span className={status.className}>{status.label}</span>
      </div>
      {resource.details && <p>{resource.details}</p>}
      <p className="help-resource-facts">
        {resource.location && (
          <>
            <a href={directionsTo(resource.location)} target="_blank" rel="noopener noreferrer">{resource.location}</a>
            {resource.region ? ` · ${resource.region}` : ''}
          </>
        )}
        {resource.hours && <span> · {resource.hours}</span>}
      </p>
      <p className="help-resource-meta">
        {resource.verifiedAt && `Checked ${formatShortDate(resource.verifiedAt)}`}
        {resource.source?.publisher && (
          <>
            {resource.verifiedAt ? ' · ' : ''}
            {resource.source.url
              ? <a href={resource.source.url} target="_blank" rel="noopener noreferrer">{resource.source.publisher}</a>
              : resource.source.publisher}
          </>
        )}
      </p>
    </li>
  );
};

Resource.propTypes = {
  resource: PropTypes.shape({
    _id: PropTypes.string,
    name: PropTypes.string,
    details: PropTypes.string,
    location: PropTypes.string,
    region: PropTypes.string,
    hours: PropTypes.string,
    status: PropTypes.string,
    verifiedAt: PropTypes.instanceOf(Date),
    source: PropTypes.shape({ publisher: PropTypes.string, url: PropTypes.string }),
  }).isRequired,
};

const Help = () => {
  const { emergency, briefing, briefingItems, resources, ready } = useTracker(() => {
    const subs = [
      Meteor.subscribe(HelpResources.publicationName),
      Meteor.subscribe(EmergencyState.publicationName),
      Meteor.subscribe(HelpBriefing.publicationName),
      Meteor.subscribe(HelpBriefingItems.publicationName),
    ];
    return {
      emergency: EmergencyState.collection.findOne(EmergencyState.id),
      briefing: HelpBriefing.collection.findOne(HelpBriefing.id),
      briefingItems: HelpBriefingItems.collection.find({}, { sort: { order: 1, createdAt: 1 } }).fetch(),
      resources: HelpResources.collection.find({}, { sort: { status: 1, name: 1 } }).fetch(),
      ready: subs.every(sub => sub.ready()),
    };
  });
  const [notices, setNotices] = useState(null);
  useEffect(() => {
    Meteor.call('help.countyNotices', (error, list) => setNotices(error ? [] : list));
  }, []);

  const byKind = RESOURCE_KINDS
    .map(kind => ({ ...kind, items: resources.filter(resource => resource.kind === kind.value) }))
    .filter(kind => kind.items.length > 0);
  const report = briefing?.active && briefingItems.length > 0 ? briefing : null;
  const jumps = [
    ...(report ? briefingSections(briefingItems) : []),
    ...byKind,
  ];

  return (
    <Container id="help" className="page-shell py-4 help-page">
      <PageHead title="Help" eyebrow={emergency?.active ? emergency.headline : 'Kauaʻi'}>
        {emergency?.active && emergency.message ? emergency.message : 'Water, food, shelter, power, and where to ask. Checked by people, not guessed.'}
      </PageHead>

      {jumps.length > 0 && (
        <nav className="help-jump" aria-label="On this page">
          {jumps.map(jump => <a key={jump.value} href={`#help-${jump.value}`}>{jump.label}</a>)}
        </nav>
      )}

      {report && <SituationReport briefing={report} items={briefingItems} />}

      {ready && jumps.length === 0 && (
        <p className="mb-panel">Nothing is listed right now. When there is, it will be here.</p>
      )}

      {report && byKind.length > 0 && <h2 className="help-divider">Where to find help</h2>}

      {byKind.map(kind => (
        <section key={kind.value} className="help-section" id={`help-${kind.value}`} aria-labelledby={`help-${kind.value}-title`}>
          <h2 id={`help-${kind.value}-title`}>{kind.label}</h2>
          <p className="help-section-blurb">{kind.blurb}</p>
          <ul className="help-list">
            {kind.items.map(resource => <Resource key={resource._id} resource={resource} />)}
          </ul>
        </section>
      ))}

      <section className="help-section" aria-labelledby="help-county-title">
        <h2 id="help-county-title">Latest from the County of Kauaʻi</h2>
        {notices === null && <p className="help-section-blurb">Checking…</p>}
        {notices && notices.length === 0 && (
          <p className="help-section-blurb">
            The county&apos;s page could not be reached just now. Try <a href="https://www.kauai.gov/County-Press-Releases">kauai.gov</a> directly.
          </p>
        )}
        {notices && notices.length > 0 && (
          <ul className="help-list">
            {notices.map(notice => (
              <li key={notice.url} className="help-resource">
                <div className="help-resource-head">
                  <a href={notice.url} target="_blank" rel="noopener noreferrer"><strong>{notice.title}</strong></a>
                </div>
                {notice.summary && <p>{notice.summary}</p>}
                {notice.publishedOn && <p className="help-resource-meta">Published {formatShortDate(notice.publishedOn)}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="help-footnote">
        In an emergency call 911. Kauaʻi Emergency Management Agency: <a href="https://www.kauai.gov/KEMA">kauai.gov/KEMA</a>.
      </p>
    </Container>
  );
};

export default Help;
