import { useEffect, useState } from 'react';
import { KAUAI, regionNear } from './geo';

const STORAGE_KEY = 'mb-origin';

/**
 * Where to measure from.
 *
 * Asks the browser once, remembers the answer, and falls back to the middle of
 * the island. The fallback is not a failure state — most people opening this
 * are on Kauaʻi, and a sensible default beats a permission prompt on first
 * paint. So the prompt only fires when someone asks for it by pressing "Use my
 * location", never on mount.
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

  const locate = () => {
    if (!navigator.geolocation) {
      setStatus('unsupported');
      return;
    }
    setStatus('locating');
    navigator.geolocation.getCurrentPosition(
      position => {
        const point = { lat: position.coords.latitude, lng: position.coords.longitude };
        setOrigin({ ...point, label: regionNear(point) });
        setStatus('located');
      },
      // Declining is an ordinary choice, so it leaves the island default in
      // place rather than putting an error on the page.
      () => setStatus('denied'),
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
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
