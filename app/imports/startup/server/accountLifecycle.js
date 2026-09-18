import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';

/**
 * How an account is born, mailed, and told the truth.
 *
 * - Sign-up sends a verification email. Posting a listing needs a verified
 *   address (see requireVerifiedEmail in Methods.js): with no captcha, ever,
 *   that is what stands between the walls and a script that makes accounts.
 * - Sign-in errors are ambiguous on purpose. "No user with that email" told a
 *   stranger which addresses had accounts here; "Incorrect password" or
 *   nothing at all tells them nothing.
 * - Sessions last ninety days; the resume token is refreshed on use.
 * - A browser may not write `profile` on the user document. Meteor lets it by
 *   default, which made Meteor.users.profile a bag any client could fill.
 * - The mail is plain text, signed by the site, with the link and one sentence.
 *   Without a MAIL_URL (development) Meteor prints it to this log instead.
 */
Accounts.config({
  sendVerificationEmail: true,
  ambiguousErrorMessages: true,
  loginExpirationInDays: 90,
});

Meteor.users.deny({
  update() { return true; },
});

/**
 * What a new user document may carry from the browser: the moment they agreed
 * to the terms, and nothing else. `options.profile` used to be copied whole,
 * so a sign-up could arrive with any object at all under `profile`.
 */
Accounts.onCreateUser((options, user) => {
  const agreed = options.profile?.agreedToTermsAt;
  return {
    ...user,
    profile: agreed ? { agreedToTermsAt: new Date(agreed) } : {},
  };
});

const siteName = () => Meteor.settings.public?.siteName || 'MatchBook';
const fromAddress = () => Meteor.settings.mail?.from || `${siteName()} <no-reply@localhost>`;

Accounts.emailTemplates.siteName = siteName();
Accounts.emailTemplates.from = fromAddress();

Accounts.emailTemplates.verifyEmail = {
  subject: () => `Confirm your email for ${siteName()}`,
  text: (user, url) => [
    `Hi${user.profile?.firstName ? ` ${user.profile.firstName}` : ''},`,
    '',
    `Tap the link to confirm this is your address, and you can start posting on ${siteName()}:`,
    '',
    url,
    '',
    'If you did not sign up, ignore this and nothing will happen.',
  ].join('\n'),
};

Accounts.emailTemplates.resetPassword = {
  subject: () => `Reset your ${siteName()} password`,
  text: (user, url) => [
    'Hi,',
    '',
    'Somebody — hopefully you — asked to reset the password for this address. The link works once and for the next day:',
    '',
    url,
    '',
    'If that was not you, ignore this. Your password stays as it is.',
  ].join('\n'),
};

// The pages that finish what the mail started. Meteor builds these into the
// mail from ROOT_URL; they have to match the routes in App.jsx.
Accounts.urls.verifyEmail = token => Meteor.absoluteUrl(`verify-email/${token}`);
Accounts.urls.resetPassword = token => Meteor.absoluteUrl(`reset-password/${token}`);

/** The seeded development accounts count as verified: nobody reads their mail. */
Meteor.startup(() => {
  (Meteor.settings.defaultAccounts || []).forEach(account => {
    Meteor.users.update(
      { username: account.email, 'emails.address': account.email, 'emails.verified': { $ne: true } },
      { $set: { 'emails.$.verified': true } },
    );
  });
});
