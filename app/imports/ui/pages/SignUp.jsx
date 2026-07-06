import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import PropTypes from 'prop-types';
import swal from 'sweetalert';
import { Link, Navigate } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Button, Col, Container, Form, Row } from 'react-bootstrap';
import { ArrowLeft, ArrowRight } from 'react-bootstrap-icons';
import { CLUB_CATEGORY_OPTIONS } from '../utilities/helpers';

const SignUp = ({ location }) => {
  const [currentStep, setCurrentStep] = useState(1);
  const [redirectToReferer, setRedirectToRef] = useState(false);
  const [formData, setFormData] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [interests, setInterests] = useState([]);

  const updateField = event => {
    const { name, value } = event.target;
    setFormData(previous => ({ ...previous, [name]: value }));
  };

  const toggleInterest = interest => {
    setInterests(previous => (previous.includes(interest) ? previous.filter(item => item !== interest) : [...previous, interest]));
  };

  const handleNext = () => setCurrentStep(step => Math.min(step + 1, 3));
  const handlePrevious = () => setCurrentStep(step => Math.max(step - 1, 1));

  const submit = event => {
    event.preventDefault();
    const { email, password, firstName, lastName } = formData;

    Accounts.createUser({ email, username: email, password }, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
        return;
      }
      Meteor.call('createUserProfile', Meteor.userId(), email, firstName, lastName, interests, profileError => {
        if (profileError) {
          swal('Error', profileError.reason || profileError.message, 'error');
        } else {
          swal('Success', 'Registration successful!', 'success');
          setRedirectToRef(true);
        }
      });
    });
  };

  const { from } = location?.state || { from: { pathname: '/' } };
  if (redirectToReferer) {
    return <Navigate to={from} />;
  }

  return (
    <Container id="signup-page" fluid className="auth-page">
      <Row className="min-vh-100 g-0">
        <Col lg={5} className="auth-side-panel">
          <div>
            <h2>Already a member?</h2>
            <Button variant="outline-light" as={Link} to="/signin" className="form-controlsignup">Sign in</Button>
          </div>
        </Col>
        <Col lg={7} className="auth-form-panel">
          <Form onSubmit={submit} className="auth-card">
            <h1>Join UHnify</h1>
            <div className="stepper mb-4">
              {[1, 2, 3].map(step => <span key={step} className={step <= currentStep ? 'active' : ''}>{step}</span>)}
            </div>
            {currentStep === 1 && (
              <>
                <Form.Group controlId="signup-form-email">
                  <Form.Label>Email</Form.Label>
                  <Form.Control name="email" type="email" value={formData.email} onChange={updateField} required />
                </Form.Group>
                <Form.Group controlId="signup-form-password">
                  <Form.Label>Password</Form.Label>
                  <Form.Control name="password" type="password" value={formData.password} onChange={updateField} required />
                </Form.Group>
                <Button type="button" onClick={handleNext} className="form-controlsubmit btn-solid-primary">Next <ArrowRight /></Button>
              </>
            )}

            {currentStep === 2 && (
              <>
                <Row>
                  <Col md={6}>
                    <Form.Group controlId="signup-form-first-name">
                      <Form.Label>First Name</Form.Label>
                      <Form.Control name="firstName" value={formData.firstName} onChange={updateField} required />
                    </Form.Group>
                  </Col>
                  <Col md={6}>
                    <Form.Group controlId="signup-form-last-name">
                      <Form.Label>Last Name</Form.Label>
                      <Form.Control name="lastName" value={formData.lastName} onChange={updateField} required />
                    </Form.Group>
                  </Col>
                </Row>
                <div className="d-flex gap-3">
                  <Button type="button" onClick={handlePrevious} className="btn-soft-primary"><ArrowLeft /> Back</Button>
                  <Button type="button" onClick={handleNext} className="form-controlsubmit btn-solid-primary">Next <ArrowRight /></Button>
                </div>
              </>
            )}

            {currentStep === 3 && (
              <>
                <div className="tag-container mb-4">
                  {CLUB_CATEGORY_OPTIONS.map(interest => (
                    <button key={interest} type="button" className={`tag-label ${interests.includes(interest) ? 'selected' : ''}`} onClick={() => toggleInterest(interest)}>
                      {interest}
                    </button>
                  ))}
                </div>
                <div className="d-flex gap-3">
                  <Button type="button" onClick={handlePrevious} className="btn-soft-primary"><ArrowLeft /> Back</Button>
                  <Button id="signup-form-submit" type="submit" className="form-controlsubmit btn-solid-primary">Join</Button>
                </div>
              </>
            )}
          </Form>
        </Col>
      </Row>
    </Container>
  );
};

SignUp.propTypes = {
  location: PropTypes.shape({
    state: PropTypes.shape({
      from: PropTypes.shape({ pathname: PropTypes.string }),
    }),
  }),
};

SignUp.defaultProps = {
  location: { state: { from: { pathname: '/' } } },
};

export default SignUp;
