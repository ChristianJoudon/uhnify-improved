import { Selector } from 'testcafe';

class AgendaPage {
  constructor() {
    this.pageId = '#agenda-page';
    this.pageSelector = Selector(this.pageId);
  }

  /** Asserts that this page is currently displayed. */
  async isDisplayed(testController) {
    await testController.expect(this.pageSelector.exists).ok();
  }
}

export const agendaPage = new AgendaPage();
