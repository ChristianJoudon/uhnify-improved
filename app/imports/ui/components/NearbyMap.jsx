import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { KAUAI, KAUAI_BOUNDS, positionOf } from '../utilities/geo';
import { KAUAI_COAST } from '../utilities/kauaiCoast';
import { KAUAI_ROADS } from '../utilities/kauaiRoads';
import { TOPICS } from '../utilities/topics';

/**
 * Where everything is.
 *
 * OpenStreetMap through Leaflet — no key, no billing, no account, which is why
 * the map exists at all rather than waiting on one. Pins are drawn rather than
 * imported so they carry the topic's own colour: the map and the wall below it
 * say the same thing in the same language.
 *
 * A record with no resolvable place is simply absent. It is still in the list
 * underneath; it just cannot honestly be put anywhere.
 */

/**
 * A pin in its topic's own colour — the same one its card is drawn in.
 *
 * The fill used to be `chipInk`, which is the topic's dark TEXT colour, so a
 * Music pin was maroon while a Music card is pale pink. Same family, but not
 * the same colour, and on a map the two sit near enough to each other for the
 * mismatch to read as two different systems. The fill is the card's own pastel
 * now, ringed and numbered in charcoal — the same ink the cards set their type
 * in, so a pin reads as a small piece of the card it stands for.
 *
 * The numeral is the one part that cannot follow the ring. White on these
 * pastels measures between 1.13:1 and 1.21:1 — not "low contrast" but very
 * nearly invisible, since 1:1 is no difference at all. Charcoal on the same
 * fills clears 10:1, and the count is the only thing on this map carrying a
 * number worth reading.
 */
const pinFor = (topicKey, count, chosen) => {
  const topic = TOPICS[topicKey] || {};
  const fill = topic.chip || '#e8edf3';
  // Scaled by how much is here, gently — a place with forty listings should
  // read as busier than one with two without becoming a blob.
  const size = Math.round(24 + Math.min(Math.sqrt(count), 6) * 3.4);
  const r = size / 2;
  const label = count > 1
    ? `<text x="${r}" y="${r + 3.6}" text-anchor="middle" font-size="${count > 99 ? 9 : 10.5}" font-weight="700" fill="#303234" font-family="DM Sans, sans-serif">${count > 99 ? '99+' : count}</text>`
    : '';
  return L.divIcon({
    className: `mb-pin${chosen ? ' is-chosen' : ''}`,
    html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${r}" cy="${r}" r="${r - 2.5}" fill="${fill}" stroke="#303234" stroke-width="${chosen ? 2.6 : 1.6}" />
      ${label}
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [r, r],
  });
};

/**
 * The island's colour. The sea has no constant here: it is the map container's
 * own background (--mb-sea in style.css), and the island is a polygon laid on it.
 */
const LAND = '#f7ece0';
/** The road network's ink, and its two weights. */
const ROAD = '#3f3a35';

/**
 * The names on the map. `from` is the zoom at which a name appears: the towns
 * a visitor steers by at the whole-island view, the rest a step closer.
 * `side` is where the name sits from its town - inland, always, because the
 * pins gather on the coast road and a name under a pin is no name at all.
 */
const KAUAI_TOWNS = [
  { name: 'Līhuʻe', at: [21.9811, -159.3711], from: 0, side: 'w' },
  { name: 'Kapaʻa', at: [22.0881, -159.3380], from: 0, side: 'w' },
  { name: 'Hanalei', at: [22.2035, -159.5010], from: 0, side: 's' },
  { name: 'Waimea', at: [21.9572, -159.6698], from: 0, side: 'n' },
  { name: 'Kōloa', at: [21.9067, -159.4697], from: 10, side: 'n' },
  { name: 'Princeville', at: [22.2180, -159.4790], from: 11, side: 's' },
  { name: 'Kīlauea', at: [22.2122, -159.4061], from: 11, side: 's' },
  { name: 'Anahola', at: [22.1444, -159.3133], from: 11, side: 'w' },
  { name: 'Wailua', at: [22.0525, -159.3380], from: 12, side: 'w' },
  { name: 'Hanamāʻulu', at: [21.9983, -159.3583], from: 12, side: 'w' },
  { name: 'Poʻipū', at: [21.8769, -159.4572], from: 11, side: 'n' },
  { name: 'Kalāheo', at: [21.9244, -159.5269], from: 11, side: 'n' },
  { name: 'ʻEleʻele', at: [21.9075, -159.5833], from: 12, side: 'e' },
  { name: 'Hanapēpē', at: [21.9114, -159.5947], from: 11, side: 'n' },
  { name: 'Kekaha', at: [21.9669, -159.7119], from: 11, side: 'n' },
  { name: 'Hāʻena', at: [22.2206, -159.5606], from: 11, side: 's' },
  { name: 'Kōkeʻe', at: [22.1303, -159.6586], from: 11, side: 's' },
];

/** The widest a pin ever gets, at the top of the count scale in `pinFor`. */
const PIN_MAX = 24 + 6 * 3.4;
/**
 * Two pins closer together than this on screen become one.
 *
 * Derived from the pin size rather than picked: at a flat 40 the threshold was
 * narrower than a busy pin's own diameter, so two crowded places could never
 * be far enough apart to draw separately and the north shore always came out
 * as one disc clipping another. A pin's width plus a little air.
 */
const CLUSTER_PX = PIN_MAX + 8;

const NearbyMap = ({ records, origin, onSelect, chosen, height }) => {
  const holder = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const youRef = useRef(null);
  // Bumped on every zoom, because how close two pins LOOK is a function of the
  // zoom, not of the data — the clustering has to be recomputed at each level.
  const [zoomTick, setZoomTick] = useState(0);

  /** Group by exact position, so two things at one venue are one pin. */
  const pins = useMemo(() => {
    const byPlace = new Map();
    records.forEach(record => {
      const at = positionOf(record);
      if (!at) {
        return;
      }
      const key = `${at.lat},${at.lng}`;
      const existing = byPlace.get(key);
      if (existing) {
        existing.records.push(record);
      } else {
        byPlace.set(key, { at, records: [record] });
      }
    });
    return [...byPlace.values()];
  }, [records]);

  // Create once. Re-creating on every render would fight Leaflet's own state.
  useEffect(() => {
    if (map.current || !holder.current) {
      return undefined;
    }
    map.current = L.map(holder.current, {
      center: [KAUAI.lat, KAUAI.lng],
      zoom: 10,
      // Fractional zoom. Leaflet snaps to whole zoom levels by default, and a
      // whole level is a doubling — so fitting the island landed on the largest
      // power of two that fit and left up to half the frame as sea. With the
      // snap off the fit is exact and Kauaʻi runs to the padding.
      zoomSnap: 0,
      zoomDelta: 0.5,
      // With no tile layer to say where the detail ends, Leaflet zooms for
      // ever. The coastline and the roads are good to about a town's width;
      // past that the frame is one colour and a line.
      maxZoom: 14,
      scrollWheelZoom: false,
      // Grab it and move it. How far it goes, and when a finger gets to do the
      // same, is decided with the frame below (`keepTheIsland`, `holdOrRelease`).
      dragging: true,
      // A solid edge rather than a rubber one: the map stops, and nothing
      // animates back against the hand that moved it.
      maxBoundsViscosity: 1,
      // Leaflet draws vectors for the view plus a margin and redraws them when
      // a move ENDS. A tenth of the view, its default, is one short drag: the
      // "you are here" ring should still be there at the far end of a long one.
      renderer: L.svg({ padding: 0.5 }),
      attributionControl: true,
    });
    // The island is our own geometry (kauaiCoast.js) on a flat sea: no tiles,
    // no provider, no key. It sits in a pane of its own beneath the roads and
    // pins, and takes no clicks.
    map.current.createPane('mb-land').style.zIndex = 200;
    L.polygon(KAUAI_COAST, {
      pane: 'mb-land',
      stroke: true,
      color: LAND,
      weight: 1,
      fillColor: LAND,
      fillOpacity: 1,
      interactive: false,
      // Never cut to the drawn margin (and the stylesheet lets the drawing
      // overflow it): mid-drag, a clipped island is a straight edge where the
      // north shore should be, held until the hand lets go.
      noClip: true,
    }).addTo(map.current);
    // Town names, in the island's own spelling, as type rather than as tiles.
    // The smaller places wait for a closer look so the whole-island view is
    // not a crowd of words.
    const towns = L.layerGroup().addTo(map.current);
    const drawTowns = () => {
      towns.clearLayers();
      const zoom = map.current.getZoom();
      KAUAI_TOWNS.filter(town => zoom >= town.from).forEach(town => {
        L.marker(town.at, {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({ className: `mb-map-town mb-map-town--${town.side}`, html: `<span>${town.name}</span>`, iconSize: [0, 0] }),
        }).addTo(towns);
      });
    };
    drawTowns();
    map.current.on('zoomend', drawTowns);
    map.current.attributionControl.addAttribution('\u00A9 OpenStreetMap contributors');
    // OpenStreetMap keeps its credit — that is the licence.
    // Leaflet's own "Leaflet | 🇺🇦" prefix is not part of it, and on a phone that
    // optional branding took nearly half the map's width.
    map.current.attributionControl.setPrefix('');
    /**
     * The roads, once, beneath everything else.
     *
     * Added before the pin layer so a pin is never underneath a road, and drawn
     * with `interactive: false` so the network cannot swallow a click meant for
     * a pin or for the map.
     */
    const roads = L.layerGroup().addTo(map.current);
    KAUAI_ROADS.forEach(({ k, p }) => {
      L.polyline(p, {
        color: ROAD,
        weight: k === 'major' ? 1.6 : 1,
        opacity: k === 'major' ? 0.75 : 0.5,
        lineJoin: 'round',
        lineCap: 'round',
        interactive: false,
        noClip: true,
      }).addTo(roads);
    });

    layer.current = L.layerGroup().addTo(map.current);
    map.current.on('zoomend', () => setZoomTick(tick => tick + 1));
    return () => {
      map.current.remove();
      map.current = null;
    };
  }, []);

  // Redraw the pins whenever the filtered set changes.
  useEffect(() => {
    if (!layer.current) {
      return;
    }
    layer.current.clearLayers();
    // Merge pins that would overlap on screen. Grouping by exact coordinate — as
    // this did — only merges listings at the very same venue, so the east shore
    // came out as a pile of half-covered discs with their counts unreadable.
    const clustered = [];
    const taken = new Set();
    const placed = pins.map(p => ({ ...p, xy: map.current.latLngToLayerPoint([p.at.lat, p.at.lng]) }));
    placed.forEach((pin, i) => {
      if (taken.has(i)) {
        return;
      }
      taken.add(i);
      const group = [pin];
      placed.forEach((other, j) => {
        if (!taken.has(j) && pin.xy.distanceTo(other.xy) < CLUSTER_PX) {
          taken.add(j);
          group.push(other);
        }
      });
      clustered.push({
        at: {
          lat: group.reduce((sum, g) => sum + g.at.lat, 0) / group.length,
          lng: group.reduce((sum, g) => sum + g.at.lng, 0) / group.length,
        },
        records: group.flatMap(g => g.records),
      });
    });

    clustered.forEach(({ at, records: here }) => {
      const [first] = here;
      const marker = L.marker([at.lat, at.lng], {
        icon: pinFor(first.topicKey, here.length, chosen && Math.abs(chosen.lat - at.lat) < 1e-6 && Math.abs(chosen.lng - at.lng) < 1e-6),
        keyboard: true,
        riseOnHover: true,
        title: `${here.length} here — ${(first.location || 'this place').replace(/"/g, '')}`,
      });
      // No popup. A popup here listed every record at the venue by title, which
      // for a weekly market is the same six words six times over a "+23 more" —
      // a worse list than the wall already below it. Clicking hands the place
      // up instead, and the wall answers.
      marker.on('click', () => onSelect && onSelect({
        lat: at.lat,
        lng: at.lng,
        label: first.location || '',
        count: here.length,
      }));
      marker.addTo(layer.current);
    });

  }, [pins, onSelect, chosen, zoomTick]);

  /**
   * The frame opens on the whole island, and lets go of it only so far.
   *
   * Fitting is deliberately kept out of the drawing effect above and off the
   * record set entirely. Fitting the PINS did two bad things at once: it fed
   * the redraw effect — fitBounds moves the zoom, zoomend bumps the tick that
   * re-clusters, the tick re-runs the fit — so the map crept in on itself and
   * would not come back out; and it let a filter that emptied one shore snap
   * the frame in and crop the coast, so the island changed shape as a side
   * effect of choosing a category.
   *
   * It re-runs on resize because the frame's height follows its width, and a
   * fit is only true for the size it was measured at.
   *
   * The map can be dragged, and a map of one island in an empty sea needs
   * three promises for that to be safe. There were none: one flick with its
   * inertia sent Kauaʻi thousands of pixels out of frame, with nothing on
   * screen to steer back by and no way home but a reload.
   *
   *  - The island never leaves. However far in the zoom, the view may run
   *    past the island's box by a third of itself and no further, so there is
   *    always coast in frame to come back along.
   *  - The whole island is as far out as it goes. Beyond that the map is only
   *    more sea, and the speck in the middle of it is nobody's destination.
   *  - Zooming all the way back out is the way home: the island returns to
   *    the centre, wherever it had been left.
   */
  useEffect(() => {
    if (!map.current || !holder.current) {
      return undefined;
    }
    const { south, west, north, east } = KAUAI_BOUNDS;
    const island = L.latLngBounds([south, west], [north, east]);
    // The frame's aspect is set to the island's, so a small even padding is
    // all the buffer the coastline needs on any side — and the neighbouring
    // island 17 miles west stays outside the frame by geometry rather than by
    // being panned away from.
    const PADDING = 18;
    /** How much of the view may be open sea beyond the island's box, each way. */
    const ROAM = 1 / 3;
    /** Fractional zoom never lands exactly; this close to the whole-island zoom is the whole island. */
    const SLACK = 0.01;
    const finger = window.matchMedia ? window.matchMedia('(pointer: coarse)') : null;
    let home = null;

    const roaming = () => home !== null && map.current.getZoom() > map.current.getMinZoom() + SLACK;

    const keepTheIsland = () => {
      const view = map.current.getBounds();
      const lat = (view.getNorth() - view.getSouth()) * ROAM;
      const lng = (view.getEast() - view.getWest()) * ROAM;
      map.current.setMaxBounds([[south - lat, west - lng], [north + lat, east + lng]]);
    };

    /**
     * A mouse may always drag. A finger may once the map has been zoomed into:
     * at the whole-island view a drag that starts on the map is, nearly every
     * time, someone scrolling the page — the map is most of a phone's first
     * screen, and it used to swallow that scroll. Zooming in is what says the
     * map itself is wanted, and zooming back out hands the page its scroll.
     */
    const holdOrRelease = () => {
      if (!map.current) {
        return;
      }
      if (roaming() || !(finger && finger.matches)) {
        map.current.dragging.enable();
      } else {
        map.current.dragging.disable();
      }
    };

    /**
     * The way home is a glide, and a glide can be cut short: a second press of
     * "−" while it runs stops it where it is, and that is where the island
     * would stay — for good, under a finger, which cannot drag at this zoom.
     * So going home is a state rather than a call: every time the map comes to
     * rest while it is set, the glide is taken up again from wherever it
     * stopped. Taking hold of the map is what ends it.
     */
    let homing = false;
    const goHome = () => {
      homing = true;
      map.current.panTo(home, { animate: true, duration: 0.35 });
    };
    const rest = () => {
      if (!homing) {
        return;
      }
      const off = map.current.latLngToContainerPoint(home).distanceTo(map.current.getSize().divideBy(2));
      if (roaming() || off < 2) {
        homing = false;
      } else {
        goHome();
      }
    };
    const letGo = () => {
      homing = false;
    };

    const settle = () => {
      keepTheIsland();
      holdOrRelease();
      if (home && !roaming()) {
        goHome();
      }
    };

    const fit = () => {
      const kept = roaming();
      map.current.invalidateSize({ animate: false });
      // The old floor was measured for the old frame, and a fit cannot go below a floor.
      map.current.setMinZoom(0);
      if (kept) {
        // Someone looking at Hanalei keeps Hanalei when the window changes; only the floor moves.
        map.current.setMinZoom(map.current.getBoundsZoom(island, false, L.point(PADDING * 2, PADDING * 2)));
      } else {
        map.current.fitBounds(island, { padding: [PADDING, PADDING], animate: false });
        home = map.current.getCenter();
        map.current.setMinZoom(map.current.getZoom());
      }
      keepTheIsland();
      holdOrRelease();
    };
    fit();
    map.current.on('zoomend', settle);
    map.current.on('moveend', rest);
    map.current.on('dragstart', letGo);
    const observer = new ResizeObserver(fit);
    observer.observe(holder.current);
    if (finger && finger.addEventListener) {
      finger.addEventListener('change', holdOrRelease);
    }
    return () => {
      observer.disconnect();
      if (finger && finger.removeEventListener) {
        finger.removeEventListener('change', holdOrRelease);
      }
    };
  }, []);

  // "You are here", drawn differently from a listing because it is not one.
  useEffect(() => {
    if (!map.current || !origin) {
      return;
    }
    if (youRef.current) {
      youRef.current.remove();
    }
    youRef.current = L.circleMarker([origin.lat, origin.lng], {
      radius: 7,
      color: '#eb6219',
      weight: 3,
      fillColor: '#fffdfc',
      fillOpacity: 1,
    }).addTo(map.current).bindPopup('You');
  }, [origin]);

  return (
    <div className="mb-map" style={height ? { height } : undefined}>
      <div ref={holder} className="mb-map-canvas" />
      {pins.length === 0 && (
        <p className="mb-map-empty">Nothing here to put on the map yet.</p>
      )}
    </div>
  );
};

NearbyMap.propTypes = {
  /** Anything with a location/region; each may carry a topicKey for its colour. */
  records: PropTypes.arrayOf(PropTypes.shape({})),
  origin: PropTypes.shape({ lat: PropTypes.number, lng: PropTypes.number }),
  onSelect: PropTypes.func,
  /** The place currently filtering the wall, so its pin can say so. */
  chosen: PropTypes.shape({ lat: PropTypes.number, lng: PropTypes.number }),
  /** Fixed height in px. Omit to let the stylesheet scale it to the window. */
  height: PropTypes.number,
};

NearbyMap.defaultProps = {
  records: [],
  origin: null,
  onSelect: null,
  chosen: null,
  height: 0,
};

export default NearbyMap;
