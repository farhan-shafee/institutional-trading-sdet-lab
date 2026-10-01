import { defineConfig } from '@playwright/test';
import config from './playwright.config.js';

export default defineConfig({
  ...config,
  testDir: './tests/failure-demo',
  testIgnore: [],
  projects: [{ name: 'failure-demo', use: { browserName: 'chromium' } }],
  retries: 0,
  workers: 1,
  outputDir: 'demo-results',
  reporter: [['list'], ['html', { outputFolder: 'demo-report', open: 'never' }]],
  use: { ...config.use, trace: 'on', screenshot: 'only-on-failure', video: 'retain-on-failure' },
});
