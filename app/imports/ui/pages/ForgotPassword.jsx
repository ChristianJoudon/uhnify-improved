import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Accounts } from 'meteor/accounts-base';
import { Container } from 'react-bootstrap';
import PageHead from '../components/PageHead';

/**
 * The answer is the same whether or not the address has an account, on
 * purpose: "no account with that email" would let anyone check who is here.
 */
const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [trouble, setTrouble] = useState('');

  const submit = event => {
    event.preventDefault();
    setTrouble('');
    Accounts.forgotPassword({ email: email.trim().toLowerCase() }, error => {
      // A missing account is deliberately not an error to the person asking.
      if (error && error.error !== 403) {
        setTrouble(error.reason || error.message);
        return;
      }
      setSent(true);
    });
  };

  return (
    <Container id="forgot-password" className="page-shell py-4">
      <div className="auth-shell">
        <PageHead title="Forgot your password?">We&apos;ll send a link to set a new one.</PageHead>
        {sent ? (
          <p className="mb-panel auth-form" role="status">
            If that address has an account here, a reset link is on its way. It works once, for a day.
          </p>
        ) : (
          <form className="mb-panel auth-form" onSubmit={submit}>
            <label htmlFor="forgot-email">
              <span className="mb-field-label">Email</span>
              <input
                id="forgot-email"
                className="mb-field"
                type="email"
                autoComplete="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
              />
            </label>
            {trouble && <p className="auth-error" role="alert">{trouble}</p>}
            <div className="auth-actions">
              <button type="submit" className="btn btn-solid-primary form-controlsubmit">Send the link</button>
            </div>
          </form>
        )}
        <p className="auth-alt">
          Remembered it? <Link to="/signin">Sign in</Link>
        </p>
      </div>
    </Container>
  );
};

export default ForgotPassword;
