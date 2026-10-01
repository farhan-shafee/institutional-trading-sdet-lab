import { defineConfig, devices } from '@playwright/test';

const ci = Boolean(process.env.CI);

export default defineConfig({
  testDir: './tests',
  testIgnore: ['**/failure-demo/**', '**/unit/**'],
  fullyParallel: true,
  forbidOnly: ci,
  failOnFlakyTests: true,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : 4,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://127.0.0.1:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    { name: 'service', testMatch: ['**/api/**/*.spec.ts', '**/contract/**/*.spec.ts'] },
    {
      name: 'chromium',
      testMatch: ['**/ui/**/*.spec.ts', '**/integration/**/*.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      testMatch: ['**/ui/**/*.spec.ts', '**/integration/**/*.spec.ts'],
      use: { ...devices['Desktop Firefox'] },
    },
    {
      name: 'webkit',
      testMatch: ['**/ui/**/*.spec.ts', '**/integration/**/*.spec.ts'],
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm start',
    url: 'http://127.0.0.1:3000/health',
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: '3000' },
  },
});
