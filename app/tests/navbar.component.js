import { Selector } from 'testcafe';

class NavBar {
  async openCollapsedNavIfNeeded(testController) {
    const visible = await Selector('#basic-navbar-nav').visible;
    if (!visible) {
      await testController.click('button.navbar-toggler');
    }
  }

  async openProfileMenu(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#nav-dropdown-profile');
  }

  /** If someone is logged in, then log them out, otherwise do nothing. */
  async ensureLogout(testController) {
    await this.openProfileMenu(testController);
    const logoutItem = Selector('#navbar-current-user');
    if (await logoutItem.visible) {
      await testController.click(logoutItem);
      await testController.expect(Selector('#signout-page').exists).ok();
    } else {
      await testController.pressKey('esc');
    }
  }

  async gotoSignInPage(testController) {
    await this.ensureLogout(testController);
    await this.openProfileMenu(testController);
    await testController.click('#nav-dropdown-profile-sign-in');
  }

  /** Check that the specified user is currently logged in. */
  async isLoggedIn(testController) {
    await this.openProfileMenu(testController);
    const loggedInUser = Selector('#navbar-current-user').innerText;
    await testController.expect(loggedInUser).eql('Logout');
    await testController.pressKey('esc');
  }

  /** Check that someone is logged in, then click items to logout. */
  async logout(testController) {
    await this.openProfileMenu(testController);
    await testController.click('#navbar-current-user');
  }

  /** Pull down login menu, go to sign up page. */
  async gotoSignUpPage(testController) {
    await this.ensureLogout(testController);
    await this.openProfileMenu(testController);
    await testController.click('#login-dropdown-sign-up');
  }

  async gotoBrowseClubsPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#club-drop');
    await testController.click('#browse-clubs');
  }

  async gotoMyClubsPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#club-drop');
    await testController.click('#my-clubs');
  }

  async gotoEventFinderPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#nav-dropdown-events');
    await testController.click('#event-finder');
  }

  async gotoAddClubsPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#club-drop');
    await testController.click('#add-clubs');
  }

  async gotoEventCalendarPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#nav-dropdown-events');
    await testController.click('#my-events');
  }

  async gotoCreateEventsPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#nav-dropdown-events');
    await testController.click('#create-event');
  }

  async gotoMyEventsPage(testController) {
    await this.openCollapsedNavIfNeeded(testController);
    await testController.click('#nav-dropdown-events');
    await testController.click('#my-events');
  }

  async gotoProfilePage(testController) {
    await this.openProfileMenu(testController);
    await testController.click('#profile');
  }

  async gotoMyNavClubsPage(testController) {
    await this.openProfileMenu(testController);
    await testController.click('#nav-my-clubs');
  }

  async gotoAgendaPage(testController) {
    await this.openProfileMenu(testController);
    await testController.click('#nav-calendar-events');
  }

  async gotoCustomizePage(testController) {
    await this.openProfileMenu(testController);
    await testController.click('#nav-customize');
  }
}

export const navBar = new NavBar();
