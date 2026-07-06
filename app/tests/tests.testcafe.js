import { landingPage } from './landing.page';
import { signinPage } from './signin.page';
import { signoutPage } from './signout.page';
import { navBar } from './navbar.component';
import { browseClubsPage } from './browseclubs.page';
import { myClubsPage } from './myclubs.page';
import { eventFinderPage } from './eventfinder.page';
import { addClubPage } from './addclubs.page';
import { createEventsPage } from './createevents.page';
import { myEventsPage } from './myevents.page';
import { profilePage } from './profile.page';

/* global fixture:false, test:false */

/** Credentials for one of the sample users defined in settings.development.json. */
const credentials = { username: 'john@foo.com', password: 'changeme' };

fixture('uhnify localhost with default db')
  .page('http://localhost:3000');

test('Test that landing page shows up', async (testController) => {
  await landingPage.isDisplayed(testController);
});

test('Test that landing page event card works', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await landingPage.eventCard(testController);
});

test('Test that landing page club card works', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await landingPage.browseClubCard(testController);
});

test('Test that landing page my club card works', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await landingPage.myClubCard(testController);
});

test('Test that signin and signout work', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.isLoggedIn(testController, credentials.username);
  await navBar.logout(testController);
  await signoutPage.isDisplayed(testController);
});
test('Test the BrowseClubs page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoBrowseClubsPage(testController);
  await browseClubsPage.isDisplayed(testController);
});

test('Test the MyClubs page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoMyClubsPage(testController);
  await myClubsPage.isDisplayed(testController);
});

test('Test the AddClubs page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoAddClubsPage(testController);
  await addClubPage.isDisplayed(testController);
  await addClubPage.addClub(testController);
});

test('Test the Event Finder page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoEventFinderPage(testController);
  await eventFinderPage.isDisplayed(testController);
});

test('Test the My Events page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoMyEventsPage(testController);
  await myEventsPage.isDisplayed(testController);
});

test('Test the AddEvents page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoCreateEventsPage(testController);
  await createEventsPage.isDisplayed(testController);
  await createEventsPage.addEvent(testController);
});

test('Test the Profile page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoProfilePage(testController);
  await profilePage.isDisplayed(testController);
});

test('Test the nav my clubs page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoMyNavClubsPage(testController);
  await myClubsPage.isDisplayed(testController);
});

test('Test the nav agenda page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoAgendaPage(testController);
  await eventFinderPage.isDisplayed(testController);
});

test('Test the nav customize page', async (testController) => {
  await navBar.gotoSignInPage(testController);
  await signinPage.signin(testController, credentials.username, credentials.password);
  await navBar.gotoCustomizePage(testController);
});
