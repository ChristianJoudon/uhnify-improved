import { useEffect, useState } from 'react';
import { KAUAI, regionNear } from './geo';

const STORAGE_KEY = 'mb-origin';

/**
 * Where to measure from.
 *
 * Three sources, best first. The device's own position is exact and needs
 * permission. Failing that — declined, unavailable, or a browser that blocks it
 * in an embedded frame — we ask an IP lookup, which lands within a town or so
 * and needs no permission at all. Failing both, the middle of the island.
 *
 * Nothing fires on mount: the island centre is a fine default, and a permission
 * prompt on first paint is not. It runs when someone presses the button.
 */
/** Where a position came from. Only the first two are a real answer. */
const LOCATED = ['located', 'approx'];

export const useOrigin = () => {
  // The source travels with the position, and is what "do we know where they
  // are" is read from. Comparing the origin object to KAUAI instead looked
  // right and was not: a position restored from storage is a fresh object, so
  // it never equalled the constant, and the island centre came back from disk
  // claiming to be a located one. The button that would fix it was the button
  // that had already hidden itself.
  const [{ origin, source }, setState] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved && typeof saved.lat === 'number' && LOCATED.includes(saved.source)) {
        return { origin: { lat: saved.lat, lng: saved.lng, label: saved.label }, source: saved.source };
      }
    } catch (error) {
      // Unreadable storage is the same as none.
    }
    return { origin: KAUAI, source: 'default' };
  });
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    if (!LOCATED.includes(source)) {
      return;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...origin, source }));
    } catch (error) {
      // A browser refusing storage is not a reason to lose the position.
    }
  }, [origin, source]);

  const apply = (point, how) => {
    setState({ origin: { lat: point.lat, lng: point.lng, label: regionNear(point) }, source: how });
    setStatus(how);
  };

  /**
   * Roughly where this connection is. No key, no permission; accurate to a town
   * on a fixed line and to a region on mobile data, which is the right order of
   * magnitude for "what is near me on one island".
   */
  const byNetwork = async () => {
    try {
      const response = await fetch('https://ipapi.co/json/');
      if (!response.ok) {
        throw new Error('lookup failed');
      }
      const data = await response.json();
      if (typeof data.latitude === 'number' && typeof data.longitude === 'number') {
        apply({ lat: data.latitude, lng: data.longitude }, 'approx');
        return true;
      }
    } catch (error) {
      // Offline, blocked, or rate-limited — the island default still stands.
    }
    return false;
  };

  const locate = async () => {
    setStatus('locating');
    if (navigator.geolocation) {
      const exact = await new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
          position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
          () => resolve(null),
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
        );
      });
      if (exact) {
        apply(exact, 'located');
        return;
      }
    }
    // The device would not say, so ask the network rather than giving up: most
    // people who press this want a better answer, not an explanation.
    const ok = await byNetwork();
    if (!ok) {
      setStatus('denied');
    }
  };

  const reset = () => {
    setState({ origin: KAUAI, source: 'default' });
    setStatus('idle');
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Nothing to undo if storage was never available.
    }
  };

  return { origin, status, locate, reset, isPrecise: LOCATED.includes(source) };
};
