import React from 'react';
import { Card, Col, Container, Row } from 'react-bootstrap';
import { motion } from 'framer-motion';
import { CalendarHeart, Compass, PeopleFill, ShieldCheck } from 'react-bootstrap-icons';

const rise = {
  hidden: { opacity: 0, y: 18 },
  show: index => ({ opacity: 1, y: 0, transition: { type: 'spring', stiffness: 180, damping: 22, delay: Math.min(index, 8) * 0.05 } }),
};

const VALUES = [
  { title: 'Discover', Icon: Compass },
  { title: 'Events', Icon: CalendarHeart },
  { title: 'Profiles', Icon: PeopleFill },
  { title: 'Admin', Icon: ShieldCheck },
];

const ClubDetail = () => (
  <Container className="page-shell py-5">
    <div className="page-intro">
      <h1>About</h1>
    </div>

    <Row className="g-4">
      {VALUES.map(({ title, Icon }, index) => (
        <Col md={6} key={title}>
          <motion.div variants={rise} initial="hidden" animate="show" custom={index} className="h-100">
            <Card className="value-card h-100">
              <Card.Body>
                <Icon size={26} className="value-icon" />
                <Card.Title>{title}</Card.Title>
              </Card.Body>
            </Card>
          </motion.div>
        </Col>
      ))}
    </Row>
  </Container>
);

export default ClubDetail;
