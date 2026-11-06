import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/public-browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: 'test-results/public-demo-private',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'public-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'public-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'public-webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
