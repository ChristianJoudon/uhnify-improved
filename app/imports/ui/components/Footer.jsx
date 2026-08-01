import React from 'react';
import { Container } from 'react-bootstrap';
import { Instagram, Twitter } from 'react-bootstrap-icons';
import { Link } from 'react-router-dom';
import Wordmark from './brand/Wordmark';

/** The Footer appears at the bottom of every page. */
const Footer = () => (
  <footer className="site-footer mt-auto">
    <Container className="page-shell">
      <div className="footer-row">
        <Link to="/" className="footer-brand"><Wordmark /></Link>
        <div className="footer-links">
          <Link to="/discover-events" className="footer-link">Discover</Link>
          <Link to="/upcoming-events" className="footer-link">Events</Link>
          <Link to="/search-clubs" className="footer-link">Clubs</Link>
          <Link to="/profile" className="footer-link">Profile</Link>
        </div>
        <div className="footer-socials">
          <a href="https://www.instagram.com/uhmanoanews/" target="_blank" rel="noopener noreferrer" aria-label="Instagram"><Instagram /></a>
          <a href="https://twitter.com/uhmanoa" target="_blank" rel="noopener noreferrer" aria-label="Twitter"><Twitter /></a>
        </div>
        <p className="footer-copy">© 2026 MatchBook</p>
      </div>
    </Container>
  </footer>
);

export default Footer;
