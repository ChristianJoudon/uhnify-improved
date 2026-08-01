import React from 'react';
import PropTypes from 'prop-types';

/**
 * A quiet map strip: paper-toned streets with destinations drawn as small match
 * heads. Placeholder geometry until real coordinates land — the point is that
 * place is always visible, not that the streets are accurate.
 */
const NearbyMap = ({ count }) => {
  const pins = Array.from({ length: count }, (unused, index) => ({
    x: 70 + ((index * 137) % 800),
    y: 40 + ((index * 83) % 150),
  }));

  return (
    <svg viewBox="0 0 900 220" xmlns="http://www.w3.org/2000/svg" role="img" aria-label={`Map showing ${count} places near you`}>
      <rect width="900" height="220" fill="#fff9f0" />
      {/* streets */}
      <g stroke="#e5d6c2" strokeWidth="10" strokeLinecap="round">
        <path d="M-20 70h940M-20 150h940" />
        <path d="M150 -20v260M420 -20v260M690 -20v260" />
      </g>
      <g stroke="#f0d8b8" strokeWidth="4">
        <path d="M-20 110h940M280 -20v260M560 -20v260M830 -20v260" />
      </g>
      {/* a soft park block */}
      <rect x="440" y="80" width="110" height="60" rx="8" fill="#eef1e6" />

      {/* destinations as match heads */}
      {pins.map(pin => (
        <g key={`${pin.x}-${pin.y}`} transform={`translate(${pin.x} ${pin.y})`}>
          <rect x="-2" y="0" width="4" height="16" rx="2" fill="#f0d8b8" stroke="#303234" strokeWidth="1.2" />
          <ellipse cx="0" cy="-3" rx="7" ry="9" fill="#df5834" stroke="#303234" strokeWidth="1.4" />
        </g>
      ))}

      {/* you-are-here */}
      <circle cx="300" cy="110" r="12" fill="#303234" opacity="0.12" />
      <circle cx="300" cy="110" r="5" fill="#303234" />
    </svg>
  );
};

NearbyMap.propTypes = {
  count: PropTypes.number,
};

NearbyMap.defaultProps = {
  count: 6,
};

export default NearbyMap;
