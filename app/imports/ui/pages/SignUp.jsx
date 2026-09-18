import React, { useState } from 'react';
import { Meteor } from 'meteor/meteor';
import swal from 'sweetalert';
import { Link, Navigate } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import { ArrowLeft, ArrowRight } from 'react-bootstrap-icons';
import PageHead from '../components/PageHead';
import { INTEREST_TOPIC_KEYS, TOPICS } from '../utilities/topics';
import { EMAIL_SHAPE, MIN_PASSWORD_LENGTH, TEXT_LIMITS } from '../../api/listing/limits';
import { takeReturnTo } from '../utilities/returnTo';

const STEPS = ['Account', 'Your name', 'Interests'];

const SignUp = () => {
  const [currentStep, setCurrentStep] = useState(1);
  // Where to go once the account exists; empty until then. This read a
  // `location.state.from` that react-router stopped passing as a prop two
  // major versions ago, so it was always '/': somebody invited to a private
  // group made their account and landed on the front page without the link.
  const [redirect, setRedirect] = useState('');
  const [formData, setFormData] = useState({ email: '', password: '', firstName: '', lastName: '' });
  const [interests, setInterests] = useState([]);

  const updateField = event => {
    const { name, value } = event.target;
    setFormData(previous => ({ ...previous, [name]: value }));
  };

  const toggleInterest = interest => {
    setInterests(previous => (previous.includes(interest) ? previous.filter(item => item !== interest) : [...previous, interest]));
  };

  const [stepTrouble, setStepTrouble] = useState('');
  const [agreed, setAgreed] = useState(false);

  /**
   * Each step checks what it collected before letting go of it. The form used
   * to check nothing until "Join" on the third step, so a typo in the address
   * — the one thing the person will need to get back in — surfaced only after
   * they had picked their interests, and a one-character password got through.
   */
  const troubleWithStep = step => {
    if (step === 1) {
      const address = formData.email.trim().toLowerCase();
      if (!EMAIL_SHAPE.test(address)) {
        return 'That email address does not look right.';
      }
      if (formData.password.length < MIN_PASSWORD_LENGTH) {
        return `Pick a password of at least ${MIN_PASSWORD_LENGTH} characters.`;
      }
    }
    return '';
  };
  const handleNext = () => {
    const trouble = troubleWithStep(currentStep);
    setStepTrouble(trouble);
    if (!trouble) {
      setCurrentStep(step => Math.min(step + 1, STEPS.length));
    }
  };
  const handlePrevious = () => setCurrentStep(step => Math.max(step - 1, 1));

  const submit = event => {
    event.preventDefault();
    if (!agreed) {
      setStepTrouble('Tick the box to agree to the terms.');
      return;
    }
    const { password, firstName, lastName } = formData;
    const email = formData.email.trim().toLowerCase();

    Accounts.createUser({ email, username: email, password, profile: { agreedToTermsAt: new Date() } }, error => {
      if (error) {
        swal('Error', error.reason || error.message, 'error');
        return;
      }
      Meteor.call('createUserProfile', Meteor.userId(), email, firstName, lastName, interests, profileError => {
        if (profileError) {
          swal('Error', profileError.reason || profileError.message, 'error');
        } else {
          swal('Welcome', "You're in. Let's find you something.", 'success');
          // Taken here, once: reading it clears it. See utilities/returnTo.
          setRedirect(takeReturnTo() || '/');
        }
      });
    });
  };

  if (redirect) {
    return <Navigate to={redirect} replace />;
  }

  return (
    <Container id="signup-page" className="page-shell py-4">
      <div className="auth-shell">
        {/* The one gesture the product is named for. Decorative — the
            heading under it already says where you are. */}
        <img className="auth-mark" src="/images/art-strike.webp" alt="" width="300" height="562" />
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
                  maxLength={TEXT_LIMITS.email}
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
                  minLength={MIN_PASSWORD_LENGTH}
                  required
                />
                <span className="field-hint">At least {MIN_PASSWORD_LENGTH} characters.</span>
              </label>
              {stepTrouble && <p className="auth-error" role="alert">{stepTrouble}</p>}
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
                    maxLength={TEXT_LIMITS.firstName}
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
                    maxLength={TEXT_LIMITS.lastName}
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
                {INTEREST_TOPIC_KEYS.map(key => {
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
              <label className="auth-consent" htmlFor="signup-agree">
                <input id="signup-agree" type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)} />
                <span>
                  I&apos;m 18 or older and I agree to the <Link to="/terms" target="_blank">terms</Link> and
                  the <Link to="/privacy" target="_blank">privacy policy</Link>.
                </span>
              </label>
              {stepTrouble && <p className="auth-error" role="alert">{stepTrouble}</p>}
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

export default SignUp;
