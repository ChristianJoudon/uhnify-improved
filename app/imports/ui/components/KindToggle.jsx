import React from 'react';
import PropTypes from 'prop-types';
import { CalendarEvent, People } from 'react-bootstrap-icons';

/**
 * Events or groups.
 *
 * Both browse surfaces answer the same question about two kinds of thing, so
 * they ask it the same way rather than each inventing a control. Discover is
 * general discovery and Nearby is geography-first, but "am I looking at
 * happenings or at groups" is orthogonal to both.
 */
const KindToggle = ({ value, onChange, counts }) => (
  <div className="kind-toggle" role="group" aria-label="Events or groups">
    {[
      { key: 'events', label: 'Events', Icon: CalendarEvent },
      { key: 'clubs', label: 'Groups', Icon: People },
    ].map(({ key, label, Icon }) => (
      <button
        key={key}
        type="button"
        className={`mb-chip${value === key ? ' is-on' : ''}`}
        aria-pressed={value === key}
        onClick={() => onChange(key)}
      >
        <Icon size={13} aria-hidden="true" />
        {label}
        {counts && counts[key] !== undefined && <span className="kind-toggle-count">{counts[key]}</span>}
      </button>
    ))}
  </div>
);

KindToggle.propTypes = {
  value: PropTypes.oneOf(['events', 'clubs']).isRequired,
  onChange: PropTypes.func.isRequired,
  counts: PropTypes.shape({ events: PropTypes.number, clubs: PropTypes.number }),
};

KindToggle.defaultProps = {
  counts: null,
};

export default KindToggle;
