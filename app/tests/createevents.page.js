import { Selector } from 'testcafe';

class CreateEventsPage {
  constructor() {
    this.pageId = '#add-events';
    this.pageSelector = Selector(this.pageId);
  }

  /** Asserts that this page is currently displayed. */
  async isDisplayed(testController) {
    await testController.expect(this.pageSelector.exists).ok();
  }

  async addEvent(testController) {
    await this.isDisplayed(testController);
    await testController.typeText('#title', 'Test Event');
    await testController.typeText('#eventID', '1');
    await testController.typeText('#image', '/images/codingWorkshop.png');
    await testController.typeText('#location', 'UH Mānoa');
    await testController.typeText('#description', 'An event created by the acceptance test.');
    await testController.typeText('#date', '2026-11-15');
    await testController.typeText('#createdBy', 'testcafe');
    await testController.click('#submit');
  }
}

export const createEventsPage = new CreateEventsPage();
