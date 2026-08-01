import React from 'react';
import PropTypes from 'prop-types';

// One supporting editorial ink per poster, chosen deterministically from the seed.
const INKS = [
  { field: '#e96d76', ink: '#303234' },
  { field: '#e6ae35', ink: '#303234' },
  { field: '#4c8177', ink: '#fff9f0' },
  { field: '#657d8c', ink: '#fff9f0' },
  { field: '#df5834', ink: '#fff9f0' },
];

const hash = seed => {
  let value = 0;
  for (let i = 0; i < String(seed).length; i++) {
    value = (value * 31 + String(seed).charCodeAt(i)) % 9973;
  }
  return value;
};

/**
 * Branded default poster: one pictogram, one category color, paper, charcoal
 * type, small match identifier. Used when an organizer uploads no image — never
 * a fake photograph.
 */
const CategoryPoster = ({ seed, label }) => {
  const index = hash(seed) % INKS.length;
  const { field, ink } = INKS[index];
  const initials = String(label || 'MB').replace(/[^A-Za-z ]/g, '').split(' ').filter(Boolean).slice(0, 2)
    .map(word => word[0].toUpperCase())
    .join('');

  return (
    <svg viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg" role="presentation" aria-hidden="true">
      <rect width="320" height="180" fill="#f8f1e7" />
      <rect x="0" y="0" width="320" height="180" fill={field} opacity="0.92" />
      {/* three match heads as the pictogram */}
      <g>
        {[0, 1, 2].map(i => (
          <g key={i} transform={`translate(${118 + i * 30} 52)`}>
            <rect x="4" y="14" width="6" height="44" rx="3" fill="#f0d8b8" />
            <ellipse cx="7" cy="12" rx="8" ry="10.5" fill={i === 1 ? '#df5834' : '#fff9f0'} />
          </g>
        ))}
      </g>
      <text x="160" y="140" textAnchor="middle" fontFamily="Bricolage Grotesque, sans-serif" fontSize="26" fontWeight="750" fill={ink}>
        {initials || 'MB'}
      </text>
    </svg>
  );
};

CategoryPoster.propTypes = {
  seed: PropTypes.string,
  label: PropTypes.string,
};

CategoryPoster.defaultProps = {
  seed: 'matchbook',
  label: '',
};

export default CategoryPoster;
