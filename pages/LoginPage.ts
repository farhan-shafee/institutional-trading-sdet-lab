import type { Locator, Page } from '@playwright/test';

export class LoginPage {
  readonly username: Locator;
  readonly password: Locator;
  readonly signInButton: Locator;
  readonly alert: Locator;

  constructor(private readonly page: Page) {
    this.username = page.getByLabel('Username', { exact: true });
    this.password = page.getByLabel('Password', { exact: true });
    this.signInButton = page.getByRole('button', { name: 'Sign in', exact: true });
    this.alert = page.getByRole('alert');
  }

  async goto(): Promise<void> {
    await this.page.goto('/');
  }

  async signIn(username: string, password: string): Promise<void> {
    await this.username.fill(username);
    await this.password.fill(password);
    await this.signInButton.click();
  }
}
