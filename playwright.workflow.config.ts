import { defineConfig, devices } from '@playwright/test';

// Ownership setup uses native requests. Never capture browser auth headers/storage in diagnostics.
export default defineConfig({
  testDir: './tests/workflow-browser',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: 'test-results/workflow-private',
  use: { trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'rfq-chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'rfq-firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'rfq-webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
