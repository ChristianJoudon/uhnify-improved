import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Fade the end of a row only while it actually has more to show.
 *
 * The class this drives puts a soft edge on a scrolling control row. Applying
 * it unconditionally would fade the last chip on every screen wide enough to
 * hold the whole row, which reads as a rendering fault rather than as an
 * affordance — so the fade appears only when something is genuinely tucked, and
 * goes again once you have scrolled to the end.
 *
 * Watches both axes of change: the window resizing, and the row's own contents
 * changing under it (Nearby's radius chips outlive a filter, the deck's toggle
 * does not). A resize listener alone misses the second, which is how a row ends
 * up faded over nothing after the thing it was hiding was removed.
 */
export const useTuck = () => {
  const ref = useRef(null);
  const [tucked, setTucked] = useState(false);

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) {
      return;
    }
    // A pixel of slack: sub-pixel layout leaves scrollWidth a hair over
    // clientWidth on rows that visibly fit, and a permanent fade on a row with
    // nothing hidden is the exact thing this is avoiding.
    const remaining = node.scrollWidth - node.clientWidth - node.scrollLeft;
    setTucked(remaining > 1);
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) {
      return undefined;
    }
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    // The children, not only the box: a row keeps its width while what is
    // inside it changes.
    Array.from(node.children).forEach(child => observer.observe(child));
    return () => {
      node.removeEventListener('scroll', measure);
      observer.disconnect();
    };
  }, [measure]);

  return { ref, className: `mb-tuck${tucked ? ' is-tucked' : ''}` };
};
