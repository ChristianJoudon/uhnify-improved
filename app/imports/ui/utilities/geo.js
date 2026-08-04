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

/** Kauaʻi's regions, as the register names them, at the middle of each stretch.

    The North Shore anchor used to sit at 22.2119/-159.4014, which is not the
    middle of anything — it is Kīlauea exactly. That made the region and one of
    its three towns the same point, so "nearest named place" could never once
    answer Kīlauea. */
export const REGIONS = {
  Līhuʻe: { lat: 21.9811, lng: -159.3711 },
  'East Side': { lat: 22.0964, lng: -159.3390 },
  'North Shore': { lat: 22.2150, lng: -159.4600 },
  'South Shore': { lat: 21.9061, lng: -159.4690 },
  'West Side': { lat: 21.9544, lng: -159.6706 },
};

/**
 * The towns, each at its own coordinates.
 *
 * Every one of these used to be an alias for its region's anchor — thirteen
 * names pointing at five objects. Two things went wrong because of it. A person
 * standing in Kīlauea could only ever be told "North Shore", because no other
 * answer existed. And on the map, `positionOf` resolved Hanalei, Princeville
 * and Kīlauea to one identical latitude and longitude, so the whole north shore
 * stacked into a single pin — three towns twenty minutes apart drawn as one
 * place. Real coordinates fix the label and the map in the same stroke.
 *
 * Keys are `plain()`-form — no ʻokina, no macrons — because that is what they
 * are matched against. `label` is how the place is spelled to a reader.
 */
const TOWNS = {
  hanalei: { lat: 22.2036, lng: -159.4994, label: 'Hanalei' },
  princeville: { lat: 22.2231, lng: -159.4828, label: 'Princeville' },
  kilauea: { lat: 22.2119, lng: -159.4014, label: 'Kīlauea' },
  anahola: { lat: 22.1447, lng: -159.3128, label: 'Anahola' },
  kapaa: { lat: 22.0864, lng: -159.3190, label: 'Kapaʻa' },
  wailua: { lat: 22.0522, lng: -159.3378, label: 'Wailua' },
  lihue: { lat: 21.9811, lng: -159.3711, label: 'Līhuʻe' },
  puhi: { lat: 21.9631, lng: -159.4003, label: 'Puhi' },
  koloa: { lat: 21.9067, lng: -159.4700, label: 'Kōloa' },
  poipu: { lat: 21.8747, lng: -159.4586, label: 'Poʻipū' },
  lawai: { lat: 21.9214, lng: -159.5044, label: 'Lāwaʻi' },
  kalaheo: { lat: 21.9250, lng: -159.5272, label: 'Kalāheo' },
  eleele: { lat: 21.9081, lng: -159.5836, label: 'ʻEleʻele' },
  hanapepe: { lat: 21.9089, lng: -159.5936, label: 'Hanapēpē' },
  waimea: { lat: 21.9569, lng: -159.6683, label: 'Waimea' },
  kekaha: { lat: 21.9689, lng: -159.7189, label: 'Kekaha' },
  kokee: { lat: 22.1236, lng: -159.6608, label: 'Kōkeʻe' },
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

/** Is this point on Kauaʻi at all? A little slack for the coast and for boats. */
const onIsland = point => point
  && point.lat > KAUAI_BOUNDS.south - 0.15 && point.lat < KAUAI_BOUNDS.north + 0.15
  && point.lng > KAUAI_BOUNDS.west - 0.15 && point.lng < KAUAI_BOUNDS.east + 0.15;

/** Within this of a town centre, you are in that town rather than merely on
    that side of the island. Five miles is about the gap between neighbours. */
const TOWN_MILES = 5;

/**
 * What to call where someone is: the town if they are in one, otherwise the
 * side of the island, otherwise just the island.
 *
 * The bounds check is load-bearing rather than defensive. Without it the
 * nearest-anchor search always returns SOMETHING, so a reader in Honolulu, on
 * the mainland, or behind a VPN was told with complete confidence that they
 * were on Kauaʻi's West Side.
 */
export const placeNear = point => {
  if (!onIsland(point)) {
    return KAUAI.label;
  }
  const nearest = table => Object.entries(table)
    .map(([key, at]) => ({ key, at, miles: distanceBetween(point, at) }))
    .sort((a, b) => a.miles - b.miles)[0];

  const town = nearest(TOWNS);
  if (town && town.miles <= TOWN_MILES) {
    return town.at.label;
  }
  const region = nearest(REGIONS);
  return region ? region.key : KAUAI.label;
};

/** @deprecated Kept as the region-only reading; `placeNear` is what to call. */
export const regionNear = point => {
  if (!point) {
    return KAUAI.label;
  }
  const [name] = Object.entries(REGIONS)
    .map(([label, at]) => [label, distanceBetween(point, at)])
    .sort((a, b) => a[1] - b[1])[0];
  return name;
};
