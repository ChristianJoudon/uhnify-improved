import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import PropTypes from 'prop-types';
import swal from 'sweetalert';
import { Link, Navigate } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import { ArrowLeft, ArrowRight } from 'react-bootstrap-icons';
import PageHead from '../components/PageHead';
import { TOPICS, TOPIC_KEYS } from '../utilities/topics';

const STEPS = ['Account', 'Your name', 'Interests'];

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

  const handleNext = () => setCurrentStep(step => Math.min(step + 1, STEPS.length));
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
    <Container id="signup-page" className="page-shell py-4">
      <div className="auth-shell">
        <PageHead title="Join MatchBook" eyebrow={`Step ${currentStep} of ${STEPS.length} · ${STEPS[currentStep - 1]}`}>
          Three short steps, then we start matching you.
        </PageHead>

        {/* The eyebrow already names the step in words, so the drawn version of
            the same fact stays out of the accessibility tree. */}
        <div className="mb-chip-row auth-steps" aria-hidden="true">
          {STEPS.map((label, index) => (
            <span key={label} className={`mb-chip mb-chip--sm mb-chip--static${index + 1 === currentStep ? ' is-on' : ''}`}>
              {label}
            </span>
          ))}
        </div>

        <form className="mb-panel auth-form" onSubmit={submit}>
          {currentStep === 1 && (
            <>
              <label htmlFor="signup-form-email">
                <span className="mb-field-label">Email</span>
                <input
                  id="signup-form-email"
                  className="mb-field"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={formData.email}
                  onChange={updateField}
                  required
                />
              </label>
              <label htmlFor="signup-form-password">
                <span className="mb-field-label">Password</span>
                <input
                  id="signup-form-password"
                  className="mb-field"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  value={formData.password}
                  onChange={updateField}
                  required
                />
              </label>
              <div className="auth-actions">
                <button type="button" onClick={handleNext} className="btn btn-solid-primary form-controlsubmit">
                  Next <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </>
          )}

          {currentStep === 2 && (
            <>
              <div className="field-row">
                <label htmlFor="signup-form-first-name">
                  <span className="mb-field-label">First name</span>
                  <input
                    id="signup-form-first-name"
                    className="mb-field"
                    name="firstName"
                    autoComplete="given-name"
                    value={formData.firstName}
                    onChange={updateField}
                    required
                  />
                </label>
                <label htmlFor="signup-form-last-name">
                  <span className="mb-field-label">Last name</span>
                  <input
                    id="signup-form-last-name"
                    className="mb-field"
                    name="lastName"
                    autoComplete="family-name"
                    value={formData.lastName}
                    onChange={updateField}
                    required
                  />
                </label>
              </div>
              <div className="auth-actions">
                <button type="button" onClick={handlePrevious} className="btn btn-soft-primary">
                  <ArrowLeft aria-hidden="true" /> Back
                </button>
                <button type="button" onClick={handleNext} className="btn btn-solid-primary form-controlsubmit">
                  Next <ArrowRight aria-hidden="true" />
                </button>
              </div>
            </>
          )}

          {currentStep === 3 && (
            <>
              <div>
                <h2 className="mb-panel-title" id="signup-interests-label">What you&apos;re into</h2>
                <p className="auth-note">Pick a few. They decide what we put in front of you.</p>
              </div>
              {/* The eight topics the recommender scores on, and the same list
                  Customize offers, so a pick here is one the very first deck can
                  act on. Eight of the fourteen registrar categories this replaced
                  match no topic at all, and topicFor hands an unmatched interest
                  a fallback key — so onboarding was not merely vague, it was
                  scoring a topic the user had never chosen. */}
              <div className="mb-chip-row" role="group" aria-labelledby="signup-interests-label">
                {TOPIC_KEYS.map(key => {
                  const topic = TOPICS[key];
                  const on = interests.includes(topic.label);
                  return (
                    <button
                      key={key}
                      type="button"
                      className="mb-chip"
                      aria-pressed={on}
                      onClick={() => toggleInterest(topic.label)}
                    >
                      {topic.label}
                    </button>
                  );
                })}
              </div>
              <div className="auth-actions">
                <button type="button" onClick={handlePrevious} className="btn btn-soft-primary">
                  <ArrowLeft aria-hidden="true" /> Back
                </button>
                <button id="signup-form-submit" type="submit" className="btn btn-solid-primary form-controlsubmit">
                  Join
                </button>
              </div>
            </>
          )}
        </form>

        <p className="auth-alt">
          Already a member? <Link to="/signin">Sign in</Link>
        </p>
      </div>
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
