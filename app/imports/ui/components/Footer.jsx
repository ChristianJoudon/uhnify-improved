import React from 'react';
import { Container } from 'react-bootstrap';
import { Link } from 'react-router-dom';
import Wordmark from './brand/Wordmark';

/**
 * The Footer appears at the bottom of every page.
 *
 * Its links carry the same names the navbar uses. They did not before:
 * "Discover" pointed at the swipe deck, which the nav calls Match, and "Events"
 * and "Clubs" were two more names for pages the nav already calls Calendar and
 * Nearby — four labels for three destinations, none of them matching the menu
 * the reader had just been using.
 *
 * There are no social links. The two that were here pointed at the University
 * of Hawaiʻi's Instagram and Twitter, inherited from what this app used to be:
 * someone else's accounts presented as this product's own. Better none than
 * wrong — real ones can go back when they exist.
 */
const Footer = () => (
  <footer className="site-footer mt-auto">
    <Container className="page-shell">
      <div className="footer-row">
        <Link to="/" className="footer-brand"><Wordmark /></Link>
        <div className="footer-links">
          <Link to="/discover" className="footer-link">Discover</Link>
          <Link to="/discover-events" className="footer-link">Match</Link>
          <Link to="/search-clubs" className="footer-link">Nearby</Link>
          <Link to="/upcoming-events" className="footer-link">Calendar</Link>
          <Link to="/profile" className="footer-link">Profile</Link>
        </div>
        <p className="footer-copy">© 2026 MatchBook</p>
      </div>
    </Container>
  </footer>
);

export default Footer;
