import React from 'react';
import { NavLink } from 'react-router-dom';
import { Button, Col, Container, Image, Row } from 'react-bootstrap';
import { motion } from 'framer-motion';
import { ArrowRight, Stars } from 'react-bootstrap-icons';

const FEATURES = [
  { id: 'link-event-card', to: '/upcoming-events', img: '/images/home-events.webp', title: 'Events', alt: 'Calendar and tickets' },
  { id: 'browse-club-card', to: '/search-clubs', img: '/images/home-discover.webp', title: 'Find clubs', alt: 'Search and discovery cards' },
  { id: 'my-club-card', to: '/my-clubs', img: '/images/home-saved.webp', title: 'Your clubs', alt: 'A folder of saved cards' },
];

const rise = {
  hidden: { opacity: 0, y: 24 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 160, damping: 22, delay: index * 0.08 } }),
};

const Landing = () => (
  <main id="landing-page" className="landing-page">
    <section className="hero-section">
      <Container className="page-shell">
        <Row className="align-items-center g-5">
          <Col lg={6}>
            <motion.div variants={rise} initial="hidden" animate="show" custom={0}>
              <h1>Campus, unified.</h1>
              <p className="hero-copy">Clubs, events, and your people — one calm place.</p>
              <div className="hero-actions">
                <Button as={NavLink} to="/discover-events" className="btn-solid-primary"><Stars /> Start swiping</Button>
                <Button as={NavLink} to="/search-clubs" className="btn-soft-primary">Browse clubs</Button>
              </div>
            </motion.div>
          </Col>
          <Col lg={6}>
            <motion.div className="hero-visual" variants={rise} initial="hidden" animate="show" custom={1}>
              <Image src="/images/home-hero.webp" alt="Illustrated campus with app cards" fluid />
            </motion.div>
          </Col>
        </Row>
      </Container>
    </section>

    <Container className="feature-section page-shell">
      <Row className="g-4">
        {FEATURES.map((feature, index) => (
          <Col md={4} key={feature.id}>
            <motion.div variants={rise} initial="hidden" whileInView="show" viewport={{ once: true, margin: '-40px' }} custom={index} className="h-100">
              <NavLink id={feature.id} to={feature.to} className="feature-card">
                <div className="feature-media">
                  <img src={feature.img} alt={feature.alt} />
                </div>
                <div className="feature-label">
                  {feature.title}
                  <ArrowRight />
                </div>
              </NavLink>
            </motion.div>
          </Col>
        ))}
      </Row>
    </Container>
  </main>
);

export default Landing;
