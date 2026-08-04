import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { KAUAI, KAUAI_BOUNDS, positionOf } from '../utilities/geo';
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

/** A pin in the record's own topic colour, matching its poster. */
const pinFor = (topicKey, count, chosen) => {
  const fill = (TOPICS[topicKey] && TOPICS[topicKey].chipInk) || '#303234';
  // Scaled by how much is here, gently — a place with forty listings should
  // read as busier than one with two without becoming a blob.
  const size = Math.round(24 + Math.min(Math.sqrt(count), 6) * 3.4);
  const r = size / 2;
  const label = count > 1
    ? `<text x="${r}" y="${r + 3.6}" text-anchor="middle" font-size="${count > 99 ? 9 : 10.5}" font-weight="700" fill="#fffdfc" font-family="DM Sans, sans-serif">${count > 99 ? '99+' : count}</text>`
    : '';
  return L.divIcon({
    className: `mb-pin${chosen ? ' is-chosen' : ''}`,
    html: `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle cx="${r}" cy="${r}" r="${r - 2.5}" fill="${fill}" stroke="${chosen ? '#1a1614' : '#fffdfc'}" stroke-width="${chosen ? 3 : 2.5}" />
      ${label}
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [r, r],
  });
};

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
      scrollWheelZoom: false,
      // The same courtesy for touch: without this the map swallowed a vertical
      // page scroll that happened to start on it, which on a phone is most of
      // the first screen. Pinch zoom stays.
      dragging: !L.Browser.mobile,
      attributionControl: true,
    });
    // Two layers, because they want opposite treatment. The base is thresholded
    // to two flat colours — a cream island on a navy sea — which is the only way
    // to be rid of tile seams, contour shading and the streams that read as
    // cracks at this zoom. Labels come separately and are NOT thresholded, so
    // town names stay crisp type rather than being flattened into the island.
    const base = L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      attribution: '© OpenStreetMap · © CARTO',
    }).addTo(map.current);
    // The filter goes on the layer's CONTAINER, not on each tile. Leaflet's
    // `className` option tags every tile image, which meant the blur-and-cut ran
    // 30-odd times against 30 separate transparent edges — and every tile
    // boundary came back as a pale hairline ruling the island into a grid.
    // Filtering the assembled layer once has no interior edges to find.
    base.getContainer().classList.add('mb-map-base');

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      className: 'mb-map-labels',
    }).addTo(map.current);
    // OpenStreetMap and CARTO are keeping their credit — that is the licence.
    // Leaflet's own "Leaflet | 🇺🇦" prefix is not part of it, and on a phone that
    // optional branding took nearly half the map's width.
    map.current.attributionControl.setPrefix('');
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
   * The frame holds the whole island, and holds it still.
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
   */
  useEffect(() => {
    if (!map.current || !holder.current) {
      return undefined;
    }
    const { south, west, north, east } = KAUAI_BOUNDS;
    const fit = () => {
      map.current.invalidateSize({ animate: false });
      // The frame's aspect is set to the island's, so a small even padding is
      // all the buffer the coastline needs on any side — and the neighbouring
      // island 17 miles west stays outside the frame by geometry rather than by
      // being panned away from.
      map.current.fitBounds(L.latLngBounds([south, west], [north, east]), { padding: [18, 18], animate: false });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(holder.current);
    return () => observer.disconnect();
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
      {/* The two-tone repaint of the basemap, referenced from style.css.
          Positron's water is the one fill whose blue outruns its red, so the
          alpha row below (-200R +200B) resolves to 1 over the sea and 0 over
          every shade of land, road and park. The slope is deliberately steep:
          Positron's own tiles carry faint seams a shade off open water, and a
          gentler threshold left them behind as a light grid on the sea. */}
      <svg className="mb-map-defs" aria-hidden="true" focusable="false">
        <filter id="mb-sea" colorInterpolationFilters="sRGB">
          <feColorMatrix
            in="SourceGraphic"
            result="seamask"
            type="matrix"
            values="0 0 0 0 0
                    0 0 0 0 0
                    0 0 0 0 0
                    -200 0 200 0 -0.8"
          />
          {/* Soften, then cut hard. A blur followed by a near-vertical transfer
              curve drops anything thinner than the blur — the hairline seams in
              Positron's rasters AND the streams threading the island, which at
              this zoom read as cracks rather than water — while a coastline,
              being a large edge, survives and comes through smooth. Morphology
              did the same job on the pixel grid and chewed the coast into
              stair-steps. */}
          <feGaussianBlur in="seamask" stdDeviation="2.4" result="soft" />
          <feComponentTransfer in="soft" result="closed">
            <feFuncA type="linear" slope="20" intercept="-9.5" />
          </feComponentTransfer>
          {/* Flood both sides. With the streams and shading gone the land has
              nothing left worth keeping, so painting it flat removes the last
              of the tile seams too and leaves one edge on the whole map: the
              coast.

              Deliberately NOT clipped to SourceAlpha. Leaflet lays its tiles at
              fractional pixels, so hairline transparent gaps run between them;
              clipping to the source's own alpha punched those gaps straight
              through the flood and the backdrop showed as a pale grid ruled
              across the island. The flood covers the whole filter region
              instead, and the region is the map — which is entirely tiled. */}
          <feFlood floodColor="#1b3559" result="navyFlood" />
          <feComposite in="navyFlood" in2="closed" operator="in" result="sea" />
          <feFlood floodColor="#fdf7ef" result="creamFlood" />
          <feComposite in="creamFlood" in2="closed" operator="out" result="land" />
          <feMerge>
            <feMergeNode in="land" />
            <feMergeNode in="sea" />
          </feMerge>
        </filter>
      </svg>
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
