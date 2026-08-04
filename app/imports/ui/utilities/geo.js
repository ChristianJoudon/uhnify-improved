/**
 * Where things actually are.
 *
 * The register publishes a town and a region for nearly every record but no
 * coordinates, so distance was previously a hash of the record's _id — stable,
 * and completely fictional. This resolves a record to the centre of the place
 * it named and measures from there. It is approximate by an honest amount
 * (you get "which side of the island", not "which street"), which is the right
 * precision for deciding whether to go.
 */

import { VENUES } from './venues';

/** Kauaʻi's regions, as the register names them, at their town centres. */
export const REGIONS = {
  Līhuʻe: { lat: 21.9811, lng: -159.3711 },
  'East Side': { lat: 22.0964, lng: -159.3390 },
  'North Shore': { lat: 22.2119, lng: -159.4014 },
  'South Shore': { lat: 21.9061, lng: -159.4690 },
  'West Side': { lat: 21.9544, lng: -159.6706 },
};

/** Towns the register uses in `location` when it gave no region. */
const TOWNS = {
  lihue: REGIONS['Līhuʻe'],
  kapaa: REGIONS['East Side'],
  wailua: REGIONS['East Side'],
  kilauea: REGIONS['North Shore'],
  hanalei: REGIONS['North Shore'],
  princeville: REGIONS['North Shore'],
  koloa: REGIONS['South Shore'],
  poipu: REGIONS['South Shore'],
  kalaheo: REGIONS['South Shore'],
  waimea: REGIONS['West Side'],
  hanapepe: REGIONS['West Side'],
  eleele: REGIONS['West Side'],
  kekaha: REGIONS['West Side'],
};

/** The island's rough centre — where "near me" starts before anyone says otherwise. */
export const KAUAI = { lat: 22.0964, lng: -159.5261, label: 'Kauaʻi' };

/**
 * The island's own extent, corner to corner: Kīlauea Point in the north down to
 * Makahuena in the south, Polihale in the west out to the Anahola coast.
 *
 * The map frames THIS rather than framing the pins. Fitting the pins looked
 * right until a filter emptied the west side, at which point the frame snapped
 * in and cropped the south coast — the island changing shape as a side effect
 * of choosing a category. Kauaʻi is one small island; there is no reading of
 * this map that benefits from ever seeing less than all of it.
 */
export const KAUAI_BOUNDS = { south: 21.855, west: -159.805, north: 22.245, east: -159.275 };

// Strip the ʻokina and diacritics so "Līhuʻe" and "Lihue" are the same town.
const plain = text => String(text || '')
  .normalize('NFD')
  .replace(/[̀-ͯʻ‘’']/g, '')
  .toLowerCase();

/**
 * A record's position, most specific source first: the geocoded venue, then the
 * town written into its location line, then the region it was filed under. A
 * record that gave none of those gets null, and draws no distance and no pin.
 */
export const positionOf = record => {
  if (!record) {
    return null;
  }
  const venue = VENUES[(record.location || '').trim()];
  if (venue) {
    return venue;
  }
  const haystack = plain(`${record.location || ''} ${record.region || ''}`);
  const town = Object.keys(TOWNS).find(name => haystack.includes(name));
  if (town) {
    return TOWNS[town];
  }
  return record.region && REGIONS[record.region] ? REGIONS[record.region] : null;
};

const R_MILES = 3958.8;
const rad = deg => (deg * Math.PI) / 180;

/** Great-circle miles between two points. */
export const distanceBetween = (a, b) => {
  if (!a || !b) {
    return null;
  }
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_MILES * Math.asin(Math.sqrt(h));
};

/**
 * Miles from `origin` to a record, or null when the record never said where it
 * is. Null is meaningful: the card draws no distance rather than guessing one.
 */
export const milesTo = (record, origin) => {
  const there = positionOf(record);
  return there ? distanceBetween(origin, there) : null;
};

/** "0.4 mi", "12 mi" — finer resolution close by, where it matters. */
export const milesLabel = miles => {
  if (miles === null || miles === undefined) {
    return '';
  }
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
};

/** The nearest named region to a point — how we describe where someone is. */
export const regionNear = point => {
  if (!point) {
    return KAUAI.label;
  }
  const [name] = Object.entries(REGIONS)
    .map(([label, at]) => [label, distanceBetween(point, at)])
    .sort((a, b) => a[1] - b[1])[0];
  return name;
};
