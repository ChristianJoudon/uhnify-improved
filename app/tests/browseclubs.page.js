import { Selector } from 'testcafe';

class BrowseClubsPage {
  constructor() {
    this.pageId = '#browse-clubs-page';
    this.pageSelector = Selector(this.pageId);
  }

  /** Asserts that this page is currently displayed. */
  async isDisplayed(testController) {
    await testController.expect(this.pageSelector.exists).ok();
  }
}

export const browseClubsPage = new BrowseClubsPage();
