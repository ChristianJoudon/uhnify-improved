import React from 'react';
import PropTypes from 'prop-types';

/**
 * The shared MatchBook wordmark. Header and footer use the same delivered mark
 * so the product signature stays consistent across every page.
 */
const Wordmark = ({ className }) => (
  <img
    src="/images/matchbook-rounded-tangerine-wordmark.png"
    alt="MatchBook"
    className={`mb-wordmark ${className}`.trim()}
    width="1642"
    height="331"
  />
);

Wordmark.propTypes = {
  className: PropTypes.string,
};

Wordmark.defaultProps = {
  className: '',
};

export default Wordmark;
