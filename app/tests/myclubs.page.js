import { Selector } from 'testcafe';

class MyClubsPage {
  constructor() {
    this.pageId = '#list-clubs';
    this.pageSelector = Selector(this.pageId);
  }

  /** Asserts that this page is currently displayed. */
  async isDisplayed(testController) {
    await testController.expect(this.pageSelector.exists).ok();
  }
}

export const myClubsPage = new MyClubsPage();
