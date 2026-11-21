import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/public-posttrade-browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: 'test-results/public-posttrade-private',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'public-posttrade-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'public-posttrade-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'public-posttrade-webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
