import type { Locator, Page } from '@playwright/test';

type OrderFilters = { symbol?: string; side?: string; status?: string };

export class TradeBlotterPage {
  readonly heading: Locator;
  readonly table: Locator;
  readonly rows: Locator;

  constructor(private readonly page: Page) {
    this.heading = page.getByRole('heading', { name: 'Order blotter', exact: true });
    this.table = page.getByRole('table', { name: 'Orders', exact: true });
    this.rows = this.table
      .getByRole('row')
      .filter({ has: page.getByRole('button', { name: /^View order / }) });
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  row(id: string): Locator {
    return this.table.getByTestId(`order-row-${id}`);
  }

  async filter(filters: OrderFilters): Promise<void> {
    if (filters.symbol !== undefined)
      await this.page.getByLabel('Filter symbol', { exact: true }).selectOption(filters.symbol);
    if (filters.side !== undefined)
      await this.page.getByLabel('Filter side', { exact: true }).selectOption(filters.side);
    if (filters.status !== undefined)
      await this.page.getByLabel('Filter status', { exact: true }).selectOption(filters.status);
  }

  async viewOrder(id: string): Promise<void> {
    await this.row(id)
      .getByRole('button', { name: `View order ${id}`, exact: true })
      .click();
  }
}
