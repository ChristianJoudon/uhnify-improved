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
export const useOrigin = () => {
  const [origin, setOrigin] = useState(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
      return saved && typeof saved.lat === 'number' ? saved : KAUAI;
    } catch (error) {
      return KAUAI;
    }
  });
  const [status, setStatus] = useState('idle');

  useEffect(() => {
    if (origin !== KAUAI) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(origin));
      } catch (error) {
        // A browser refusing storage is not a reason to lose the position.
      }
    }
  }, [origin]);

  const apply = (point, how) => {
    setOrigin({ lat: point.lat, lng: point.lng, label: regionNear(point) });
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
    setOrigin(KAUAI);
    setStatus('idle');
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      // Nothing to undo if storage was never available.
    }
  };

  return { origin, status, locate, reset, isPrecise: origin !== KAUAI };
};
