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

  /**
   * The host is chosen from a list of real groups now, and the creator comes
   * from the signed-in account rather than being typed in.
   */
  async addEvent(testController) {
    await this.isDisplayed(testController);
    await testController.typeText('#title', 'Test Event');
    const host = Selector('#eventID');
    await testController.click(host);
    await testController.click(host.find('option').nth(1));
    await testController.typeText('#location', 'UH Mānoa');
    await testController.typeText('#description', 'An event created by the acceptance test.');
    // datetime-local takes the date and time segments in sequence.
    await testController.typeText('#date', '11/15/2026');
    await testController.typeText('#date', '0600PM');
    await testController.click('#submit');
  }
}

export const createEventsPage = new CreateEventsPage();
