import React from 'react';
import PropTypes from 'prop-types';

/**
 * Layer 1 — the core symbol. One upright match on a dark charcoal rounded square.
 * No flame, no people, no lettering, no dimensional box. Must read at 16px.
 */
const MatchMark = ({ size, title }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 48 48"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    role={title ? 'img' : 'presentation'}
    aria-label={title || undefined}
    aria-hidden={title ? undefined : true}
    focusable="false"
  >
    <rect width="48" height="48" rx="12" fill="#303234" />
    {/* stem */}
    <rect x="21" y="16" width="6" height="21" rx="3" fill="#f0d8b8" />
    {/* head */}
    <rect x="19.5" y="9" width="9" height="12" rx="4.5" fill="#eb6219" />
    {/* fold at the base */}
    <rect x="12" y="37" width="24" height="3.4" rx="1.7" fill="#eb6219" />
  </svg>
);

MatchMark.propTypes = {
  size: PropTypes.number,
  title: PropTypes.string,
};

MatchMark.defaultProps = {
  size: 28,
  title: '',
};

export default MatchMark;
