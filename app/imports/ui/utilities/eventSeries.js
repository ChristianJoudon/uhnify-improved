/**
 * A repeating event is one listing with several dated calendar occurrences.
 * The database keeps every occurrence because a month view needs real dates;
 * browse walls, decks, and topic covers should not pretend those dates are
 * hundreds of unrelated events.
 */

const text = value => (typeof value === 'string' ? value.trim() : '');

/** Stable identity for one public listing series. */
export const eventListingKey = event => {
  const seriesId = text(event?.seriesId);
  if (seriesId) {
    return `series:${seriesId}`;
  }

  const eventId = text(event?._id);
  if (eventId) {
    return `event:${eventId}`;
  }

  // Public records always have an id. This deterministic fallback keeps the
  // helper honest in previews and tests without merging two different dates.
  return `event:${[
    text(event?.sourceId),
    text(event?.title),
    text(event?.location),
    event?.date instanceof Date ? event.date.toISOString() : text(event?.date),
  ].join('|')}`;
};

/**
 * Keep the first record supplied for each listing. Callers choose what "first"
 * means by sorting beforehand: normally the next occurrence, or a ranked one.
 */
export const collapseEventListings = events => {
  const seen = new Set();
  return events.filter(event => {
    const key = eventListingKey(event);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
};

export const eventListingCount = events => collapseEventListings(events).length;
