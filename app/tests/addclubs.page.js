import { Selector } from 'testcafe';

class AddClubsPage {
  constructor() {
    this.pageId = '#add-clubs';
    this.pageSelector = Selector(this.pageId);
  }

  /** Asserts that this page is currently displayed. */
  async isDisplayed(testController) {
    await testController.expect(this.pageSelector.exists).ok();
  }

  async addClub(testController) {
    await this.isDisplayed(testController);
    await testController.typeText('#name', 'Test Club');
    await testController.typeText('#image', '/images/LogoCircle.png');
    await testController.typeText('#location', 'UH Mānoa');
    await testController.typeText('#description', 'A club created by the acceptance test.');
    await testController.typeText('#meetingTime', 'Tuesdays at 7:30 PM');
    await testController.typeText('#categories', 'Technology, Service');
    await testController.click('#submit');
  }
}

export const addClubPage = new AddClubsPage();
