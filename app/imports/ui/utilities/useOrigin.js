import { useEffect, useState } from 'react';
import { KAUAI, placeNear } from './geo';

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

/** Past this many metres of claimed accuracy, a fix is a neighbourhood guess.
    Kauaʻi's towns are about five miles apart, so three kilometres is the point
    at which a position stops being able to tell them apart. */
const COARSE_METRES = 3000;

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
    setState({ origin: { lat: point.lat, lng: point.lng, label: placeNear(point) }, source: how });
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

  /**
   * Ask the device. Only fall back to the network when the device had no
   * answer to give — never when it was told not to give one.
   *
   * This used to swallow the error and ask the IP service on ANY failure, then
   * present the result with the same confidence as a satellite fix. On this
   * island the IP service answers with the cable company's head end in Līhuʻe,
   * so someone standing in Kīlauea pressed a button labelled "Use my location"
   * and was told they were sixteen miles away, with nothing on screen to say
   * the app had guessed.
   *
   * The options matter as much as the branching. `enableHighAccuracy: false`
   * with a ten-minute `maximumAge` invited the browser to answer from its own
   * cached network estimate — the very thing we are trying not to accept.
   */
  const locate = async () => {
    setStatus('locating');
    if (navigator.geolocation) {
      const fix = await new Promise(resolve => {
        navigator.geolocation.getCurrentPosition(
          position => resolve({
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
          }),
          error => resolve({ denied: error.code === error.PERMISSION_DENIED }),
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
      });
      // Refused is an answer. Substituting a guess for it is how the app came
      // to state a town the reader was not in.
      if (fix.denied) {
        setStatus('blocked');
        return;
      }
      if (typeof fix.lat === 'number') {
        // Metres. Beyond a few kilometres the "fix" is a network estimate the
        // browser handed back through the geolocation API, and it deserves the
        // same hedge as our own network lookup.
        apply(fix, fix.accuracy > COARSE_METRES ? 'approx' : 'located');
        return;
      }
    }
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

  return {
    origin,
    status,
    locate,
    reset,
    isPrecise: LOCATED.includes(source),
    /** Whether the position came from the device or was inferred from the
        network. The screen says which; it used to say neither. */
    isExact: source === 'located',
  };
};
