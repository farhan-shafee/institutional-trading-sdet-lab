import type { Locator, Page } from '@playwright/test';
import type { CreateOrderInput } from '../app/domain/schemas.js';

export class OrderEntryPage {
  readonly quantity: Locator;
  readonly submitButton: Locator;
  readonly alert: Locator;

  constructor(private readonly page: Page) {
    this.quantity = page.getByLabel('Quantity', { exact: true });
    this.submitButton = page.getByRole('button', { name: 'Submit order', exact: true });
    this.alert = page.getByRole('alert');
  }

  async submit(order: CreateOrderInput): Promise<void> {
    await this.page.getByLabel('Symbol', { exact: true }).selectOption(order.symbol);
    await this.page.getByLabel('Side', { exact: true }).selectOption(order.side);
    await this.quantity.fill(String(order.quantity));
    await this.page.getByLabel('Order type', { exact: true }).selectOption(order.type);
    if (order.type === 'LIMIT') {
      await this.page
        .getByLabel('Limit price', { exact: true })
        .fill(String(order.limitPrice ?? ''));
    }
    await this.submitButton.click();
  }
}
