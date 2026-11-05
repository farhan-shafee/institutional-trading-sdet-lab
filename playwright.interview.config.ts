import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/interview',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  failOnFlakyTests: true,
  timeout: 30_000,
  expect: { timeout: 5000 },
  reporter: [['list']],
  outputDir: 'test-results/interview-private',
  use: { ...devices['Desktop Chrome'], trace: 'off', screenshot: 'off', video: 'off' },
});
