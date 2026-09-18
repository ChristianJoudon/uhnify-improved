import React from 'react';
import PropTypes from 'prop-types';
import { AREA_LEVELS, BRIEFING_SECTIONS } from '../../api/help/Help';
import { formatShortDate } from '../utilities/helpers';

/**
 * The situation report, drawn on the help page while it is on.
 *
 * The order is the order the questions come in: the position first, then
 * the short answers, then "what is it like where I am going", then the
 * weeks ahead, then the questions everyone asks, then where the official
 * word lives. Every item carries its own source, because the page's whole
 * claim to be believed is that somebody read the county's update and wrote
 * down when.
 */
const Source = ({ item }) => {
  if (!item.sourceLabel && !item.url) {
    return null;
  }
  const label = item.sourceLabel || 'Source';
  return (
    <p className="help-resource-meta">
      {item.url
        ? <a href={item.url} target="_blank" rel="noopener noreferrer">{label}</a>
        : label}
    </p>
  );
};

const itemShape = PropTypes.shape({
  _id: PropTypes.string,
  section: PropTypes.string,
  title: PropTypes.string,
  headline: PropTypes.string,
  details: PropTypes.string,
  level: PropTypes.string,
  gettingAround: PropTypes.string,
  powerWater: PropTypes.string,
  beachesParks: PropTypes.string,
  recheck: PropTypes.string,
  url: PropTypes.string,
  sourceLabel: PropTypes.string,
});

Source.propTypes = { item: itemShape.isRequired };

const Glance = ({ items }) => (
  <div className="help-glance">
    {items.map(item => (
      <div key={item._id} className="help-glance-card">
        <span className="help-eyebrow">{item.title}</span>
        {item.headline && <strong>{item.headline}</strong>}
        {item.details && <p>{item.details}</p>}
        <Source item={item} />
      </div>
    ))}
  </div>
);

Glance.propTypes = { items: PropTypes.arrayOf(itemShape).isRequired };

const levelOf = value => AREA_LEVELS.find(level => level.value === value) || AREA_LEVELS[0];

const Areas = ({ items }) => (
  <>
    <ul className="help-legend" aria-label="What the colours mean">
      {AREA_LEVELS.map(level => (
        <li key={level.value}><span className={`help-level help-level--${level.value}`} />{level.label}</li>
      ))}
    </ul>
    <div className="help-areas">
      {items.map(item => {
        const level = levelOf(item.level);
        return (
          <div key={item._id} className={`help-area help-area--${level.value}`}>
            <div className="help-resource-head">
              <strong>{item.title}</strong>
              <span className={`help-status help-level-chip help-level-chip--${level.value}`}>{level.label}</span>
            </div>
            {item.headline && <p className="help-area-advice">{item.headline}</p>}
            <dl className="help-area-facts">
              {item.gettingAround && <><dt>Getting around</dt><dd>{item.gettingAround}</dd></>}
              {item.powerWater && <><dt>Power &amp; water</dt><dd>{item.powerWater}</dd></>}
              {item.beachesParks && <><dt>Beaches &amp; parks</dt><dd>{item.beachesParks}</dd></>}
            </dl>
            <Source item={item} />
          </div>
        );
      })}
    </div>
  </>
);

Areas.propTypes = { items: PropTypes.arrayOf(itemShape).isRequired };

const Ahead = ({ items }) => (
  <ul className="help-list">
    {items.map(item => (
      <li key={item._id} className="help-resource">
        <div className="help-resource-head"><strong>{item.title}</strong></div>
        {item.details && <p>{item.details}</p>}
        {item.recheck && <p className="help-recheck">Check again: {item.recheck}</p>}
        <Source item={item} />
      </li>
    ))}
  </ul>
);

Ahead.propTypes = { items: PropTypes.arrayOf(itemShape).isRequired };

const Questions = ({ items }) => (
  <ul className="help-list">
    {items.map(item => (
      <li key={item._id} className="help-resource">
        <div className="help-resource-head"><strong>{item.title}</strong></div>
        {item.details && <p>{item.details}</p>}
        <Source item={item} />
      </li>
    ))}
  </ul>
);

Questions.propTypes = { items: PropTypes.arrayOf(itemShape).isRequired };

const Links = ({ items }) => (
  <ul className="help-links">
    {items.map(item => (
      <li key={item._id}><a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a></li>
    ))}
  </ul>
);

Links.propTypes = { items: PropTypes.arrayOf(itemShape).isRequired };

const BODY = { glance: Glance, area: Areas, ahead: Ahead, question: Questions, link: Links };

/** The sections with anything in them, in the page's order. */
export const briefingSections = items => BRIEFING_SECTIONS
  .map(section => ({ ...section, items: items.filter(item => item.section === section.value) }))
  .filter(section => section.items.length > 0);

const SituationReport = ({ briefing, items }) => {
  const sections = briefingSections(items);
  // The report is as fresh as its newest line, header or item.
  const updatedAt = [briefing.updatedAt, ...items.map(item => item.updatedAt)]
    .filter(Boolean)
    .reduce((latest, when) => (when > latest ? when : latest), new Date(0));

  return (
    <div className="help-brief">
      <header className="help-brief-head">
        <h2>{briefing.title}</h2>
        <p className="help-brief-updated">Updated {formatShortDate(updatedAt)}</p>
        {briefing.lead && <p className="help-brief-lead">{briefing.lead}</p>}
        {briefing.note && <p className="help-section-blurb">{briefing.note}</p>}
      </header>

      {sections.map(section => {
        const Body = BODY[section.value];
        return (
          <section key={section.value} className="help-section" id={`help-${section.value}`} aria-labelledby={`help-${section.value}-title`}>
            <h2 id={`help-${section.value}-title`}>{section.label}</h2>
            {section.blurb && <p className="help-section-blurb">{section.blurb}</p>}
            <Body items={section.items} />
          </section>
        );
      })}
    </div>
  );
};

SituationReport.propTypes = {
  briefing: PropTypes.shape({
    title: PropTypes.string,
    lead: PropTypes.string,
    note: PropTypes.string,
    updatedAt: PropTypes.instanceOf(Date),
  }).isRequired,
  items: PropTypes.arrayOf(itemShape).isRequired,
};

export default SituationReport;
