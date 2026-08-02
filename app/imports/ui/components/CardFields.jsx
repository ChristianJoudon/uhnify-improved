import React from 'react';
import PropTypes from 'prop-types';
import {
  Building, CalendarEvent, CashCoin, CheckCircle, Envelope, GeoAlt, People, Telephone,
} from 'react-bootstrap-icons';
import { readFields } from '../utilities/cardFields';

/** The schema names a glyph; only this file knows what a glyph looks like. */
const GLYPH = {
  calendar: CalendarEvent,
  geo: GeoAlt,
  cash: CashCoin,
  people: People,
  building: Building,
  check: CheckCircle,
  phone: Telephone,
  mail: Envelope,
};

/**
 * Renders a record against a field schema. Fields with nothing to say are
 * already gone by the time they get here, so there is no empty row, no "N/A",
 * and no icon standing next to a blank. A record with nothing at all renders
 * nothing rather than an empty list.
 */
const CardFields = ({ record, schema, limit, className }) => {
  const rows = readFields(record, schema, { limit });
  if (rows.length === 0) {
    return null;
  }
  return (
    <ul className={`card-fields${className ? ` ${className}` : ''}`}>
      {rows.map(row => {
        const Icon = GLYPH[row.icon];
        return (
          <li key={row.key} className="card-field">
            {Icon && <Icon size={14} aria-hidden="true" />}
            <span>{row.value}</span>
          </li>
        );
      })}
    </ul>
  );
};

CardFields.propTypes = {
  // Any record shape — the schema is what knows how to read it.
  record: PropTypes.shape({}),
  schema: PropTypes.arrayOf(PropTypes.shape({
    key: PropTypes.string.isRequired,
    icon: PropTypes.string,
    get: PropTypes.func.isRequired,
  })).isRequired,
  /** Cap the rows on a dense surface; the detail view passes none. */
  limit: PropTypes.number,
  className: PropTypes.string,
};

CardFields.defaultProps = {
  record: null,
  limit: undefined,
  className: '',
};

export default CardFields;
