/**
 * What a card can say about a record.
 *
 * The imported register is sparse on purpose — a public listing often gives a
 * date and a street and nothing else, and half the records carry no
 * description, no cost, no organizer. So a card is not a fixed set of rows with
 * some of them empty. It is this schema read against the record: each field
 * knows how to pull its own value, and a field that comes back empty produces
 * no row at all. No blanks, no "N/A", no lonely icon with nothing beside it.
 *
 * Adding a field to every card in the app is one entry here.
 */

import { scheduleLabel } from '../../api/club/schedule';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Pinned to en-US, like every other date in the app. */
const HOUR = new Intl.DateTimeFormat('en-US', { hour: 'numeric' });
const HOUR_MINUTE = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
const clock = date => (date.getMinutes() === 0 ? HOUR : HOUR_MINUTE).format(date);

/**
 * The one definition of "there is nothing here". Anything this returns false
 * for is dropped before it can reach the page.
 */
export const hasValue = value => {
  if (value === null || value === undefined || value === false) {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(hasValue);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    // Sources write these as placeholders; they are absence, not content.
    return text !== '' && !['n/a', 'na', 'tbd', 'tba', 'unknown', 'none', '-'].includes(text.toLowerCase());
  }
  return true;
};

const asDate = value => {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "Wed Aug 5 · 6 PM", dropping the time when the record has none. */
export const whenLine = event => {
  const date = asDate(event.date);
  if (!date) {
    return '';
  }
  const day = `${DOW[date.getDay()]} ${MONTH[date.getMonth()]} ${date.getDate()}`;
  // Midnight is what a date-only listing parses to; printing "12 AM" would be
  // inventing a start time the source never gave.
  const timeless = date.getHours() === 0 && date.getMinutes() === 0;
  const end = asDate(event.endDate);
  const window = end && !timeless ? `${clock(date)}–${clock(end)}` : clock(date);
  return timeless ? day : `${day} · ${window}`;
};

/** Venue and town, whichever of the two the source actually gave. */
export const whereLine = record => [record.location, record.region]
  .filter(hasValue)
  .filter((part, index, all) => all.indexOf(part) === index)
  .join(' · ');

/** "Free", "$8–$12", "$30". Silent when the source did not say. */
export const costLine = cost => {
  if (!cost || !hasValue(cost.type) || cost.type === 'unknown') {
    return '';
  }
  if (cost.type === 'free') {
    return 'Free';
  }
  const { amountMin: min, amountMax: max } = cost;
  if (!hasValue(min)) {
    return hasValue(cost.raw) ? cost.raw : '';
  }
  const money = amount => `$${Number(amount) % 1 === 0 ? amount : Number(amount).toFixed(2)}`;
  return hasValue(max) && max !== min ? `${money(min)}–${money(max)}` : money(min);
};

/**
 * The event card's rows, in reading order. `icon` names a glyph the renderer
 * resolves — the schema stays data so it can be reordered or filtered without
 * touching JSX.
 */
export const EVENT_FIELDS = [
  { key: 'when', icon: 'calendar', get: whenLine },
  { key: 'where', icon: 'geo', get: whereLine },
  { key: 'cost', icon: 'cash', get: event => costLine(event.cost) },
  { key: 'audience', icon: 'people', get: event => event.audience },
  { key: 'host', icon: 'building', get: event => event.hostName },
  { key: 'registration', icon: 'check', get: event => event.registrationNote },
  { key: 'phone', icon: 'phone', get: event => event.phone },
];

/** The club card's rows. Same contract. */
export const CLUB_FIELDS = [
  // A recurring schedule is the better answer when there is one — it is what
  // the whole schedule data layer exists to produce, and nine of the imported
  // groups publish one. Reading meetingTime alone threw all of them away.
  { key: 'meets', icon: 'calendar', get: club => scheduleLabel(club.schedule) || club.meetingTime },
  { key: 'where', icon: 'geo', get: whereLine },
  { key: 'membership', icon: 'people', get: club => club.membership },
  { key: 'phone', icon: 'phone', get: club => club.phone },
  // `owner` is deliberately not a fallback here. It is the account that created
  // the record, not a contact the group published — falling back to it printed
  // the seeding admin's address on the sheet as though it were the group's.
  { key: 'email', icon: 'mail', get: club => club.email || club.contactInfo },
];

/**
 * Read a record against a schema. Returns only the rows that have something to
 * say, so a caller can render without writing a single conditional — and can
 * check `.length` to decide whether the whole block belongs on the page.
 */
export const readFields = (record, schema, { limit } = {}) => {
  if (!record) {
    return [];
  }
  const rows = schema
    .map(field => ({ key: field.key, icon: field.icon, value: field.get(record) }))
    .filter(row => hasValue(row.value));
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
};
