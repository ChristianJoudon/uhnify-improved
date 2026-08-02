import React, { useEffect, useMemo, useRef } from 'react';
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

const NearbyMap = ({ records, origin, onSelect, height }) => {
  const holder = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);
  const youRef = useRef(null);

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
      attributionControl: true,
    });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
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
    pins.forEach(({ at, records: here }) => {
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
      map.current.fitBounds(bounds, { padding: [36, 36], maxZoom: 13 });
    }
  }, [pins, onSelect]);

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
      color: '#e85020',
      weight: 3,
      fillColor: '#fffdfc',
      fillOpacity: 1,
    }).addTo(map.current).bindPopup('You');
  }, [origin]);

  return (
    <div className="mb-map" style={{ height }}>
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
  height: PropTypes.number,
};

NearbyMap.defaultProps = {
  records: [],
  origin: null,
  onSelect: null,
  height: 300,
};

export default NearbyMap;
