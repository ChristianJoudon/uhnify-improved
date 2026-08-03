import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { KAUAI, positionOf } from '../utilities/geo';
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
const pinFor = (topicKey, count) => {
  const fill = (TOPICS[topicKey] && TOPICS[topicKey].chipInk) || '#303234';
  const size = count > 1 ? 30 : 22;
  const label = count > 1 ? `<text x="11" y="14.5" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="DM Sans, sans-serif">${count > 99 ? '99+' : count}</text>` : '';
  return L.divIcon({
    className: 'mb-pin',
    html: `<svg width="${size}" height="${size}" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" fill="${fill}" stroke="#fffdfc" stroke-width="2.5" />
      ${label}
    </svg>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
};

/** Two pins closer together than this on screen become one. Roughly a disc and
    a half, so merged pins never clip each other. */
const CLUSTER_PX = 40;

const NearbyMap = ({ records, origin, onSelect, height }) => {
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_nolabels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      className: 'mb-map-base',
      attribution: '© OpenStreetMap · © CARTO',
    }).addTo(map.current);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd',
      maxZoom: 19,
      className: 'mb-map-labels',
    }).addTo(map.current);
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
        icon: pinFor(first.topicKey, here.length),
        keyboard: true,
        title: here.length > 1 ? `${here.length} listings here` : first.title || first.name,
      });
      const names = here.slice(0, 6).map(r => `<li>${(r.title || r.name || '').replace(/</g, '&lt;')}</li>`).join('');
      marker.bindPopup(`<strong>${(first.location || '').replace(/</g, '&lt;')}</strong><ul class="mb-pin-list">${names}</ul>${here.length > 6 ? `<em>+${here.length - 6} more</em>` : ''}`);
      if (onSelect) {
        marker.on('click', () => onSelect(here));
      }
      marker.addTo(layer.current);
    });

    // Fit to what is actually shown, so filtering the list moves the map with
    // it rather than leaving the reader to hunt.
    if (pins.length > 0) {
      const bounds = L.latLngBounds(pins.map(p => [p.at.lat, p.at.lng]));
      map.current.fitBounds(bounds, { padding: [18, 18], maxZoom: 15, animate: false });
      // No horizontal nudging beyond this. Kauaʻi's pins project to roughly a
      // 1.3 aspect and a full-width strip is nearer 2.5, so there is ocean on
      // both sides no matter what; sliding east to hide Niʻihau only bought a
      // lopsided island with a dead navy field on the other side. Centred and
      // as large as the frame allows is the better trade — and Niʻihau, unlike
      // Molokaʻi, is genuinely nearby.
    }
  }, [pins, onSelect, zoomTick]);

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
              coast. Clipped to SourceAlpha so cream cannot bleed past the
              tiles into the filter region. */}
          <feFlood floodColor="#1b3559" result="navyFlood" />
          <feComposite in="navyFlood" in2="closed" operator="in" result="sea" />
          <feFlood floodColor="#fdf7ef" result="creamFlood" />
          <feComposite in="creamFlood" in2="closed" operator="out" result="landRaw" />
          <feComposite in="landRaw" in2="SourceAlpha" operator="in" result="landFlat" />
          <feMerge>
            <feMergeNode in="landFlat" />
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
  /** Fixed height in px. Omit to let the stylesheet scale it to the window. */
  height: PropTypes.number,
};

NearbyMap.defaultProps = {
  records: [],
  origin: null,
  onSelect: null,
  height: 0,
};

export default NearbyMap;
