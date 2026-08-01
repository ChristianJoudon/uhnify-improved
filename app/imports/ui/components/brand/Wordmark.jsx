import React from 'react';
import PropTypes from 'prop-types';

/**
 * The MatchBook wordmark: charcoal letterforms where the "t" of Match is an
 * upright match — matchwood stem, orange head rising modestly above the
 * x-height. One memorable idea, no flame, no spark, fully legible.
 */
const Wordmark = ({ className }) => (
  <span className={`mb-wordmark ${className}`.trim()}>
    Ma
    <svg width="0.46em" height="1.2em" viewBox="0 0 16 36" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
      {/* stem: the vertical of the t, in matchwood */}
      <rect x="5" y="8" width="5.4" height="28" rx="2.7" fill="#f0d8b8" stroke="#303234" strokeWidth="1.6" />
      {/* crossbar, charcoal like the surrounding letters */}
      <rect x="0.8" y="14.5" width="14.4" height="3.4" rx="1.7" fill="#303234" />
      {/* head rising modestly above the x-height */}
      <ellipse cx="7.7" cy="5.4" rx="5.4" ry="6" fill="#df5834" stroke="#303234" strokeWidth="1.4" />
    </svg>
    chBook
  </span>
);

Wordmark.propTypes = {
  className: PropTypes.string,
};

Wordmark.defaultProps = {
  className: '',
};

export default Wordmark;
