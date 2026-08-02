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

  /**
   * The meeting time is picked from day pills and a time control now rather
   * than typed, and a topic replaces the free-text categories field.
   */
  async addClub(testController) {
    await this.isDisplayed(testController);
    await testController.typeText('#name', 'Test Club');
    await testController.typeText('#location', 'UH Mānoa');
    await testController.typeText('#description', 'A club created by the acceptance test.');
    // Tuesday, from the Sun-Sat row of day pills.
    await testController.click(Selector('.day-pill').nth(2));
    await testController.click(Selector('.topic-pick').withExactText('Community'));
    await testController.typeText('#tags', 'testing');
    await testController.pressKey('enter');
    await testController.click('#submit');
  }
}

export const addClubPage = new AddClubsPage();
