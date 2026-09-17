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
 * The two rows a person acts on. An address becomes a mailto link and a
 * number a tel link, so the card is where you reach an organizer from, not
 * only where you read about them. The text stays exactly as the source wrote
 * it; only the href is normalised, and only when there is something a mail
 * client or a dialer can use — a group's contact box is free text, and
 * "ask for Bob at the front desk" is neither.
 */
const CONTACT_HREF = {
  email: value => (/^[^\s@]+@[^\s@]+$/.test(value) ? `mailto:${value}` : null),
  phone: value => {
    const digits = value.replace(/\D/g, '');
    return digits ? `tel:${value.startsWith('+') ? '+' : ''}${digits}` : null;
  },
};

const contactHref = row => {
  const toHref = CONTACT_HREF[row.key];
  return toHref && typeof row.value === 'string' ? toHref(row.value.trim()) : null;
};

/**
 * A card is usually itself a hit target — the deck turns over on a tap, a
 * poster opens its sheet — and following a link inside it must not also do
 * that. Stopping the click here covers every React handler up the tree. The
 * deck's gesture library listens beneath React, so the deck separately ignores
 * a tap that lands on a link.
 */
const keepToTheLink = event => event.stopPropagation();

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
        const href = contactHref(row);
        return (
          <li key={row.key} className="card-field">
            {Icon && <Icon size={14} aria-hidden="true" />}
            {href
              // Not draggable, or a swipe that begins on the link becomes the
              // browser's own drag of the link and the card never moves.
              ? <a href={href} onClick={keepToTheLink} draggable={false}>{row.value}</a>
              : <span>{row.value}</span>}
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
