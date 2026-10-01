import { seedIds } from '../../test-data/fixtures/reference-data.js';
import { test, expect } from '../fixtures/tradeflow.fixture.js';

test('intentional UI failure records the wrong lifecycle expectation', async ({
  tradeBlotterPage,
  authenticatedPage,
}) => {
  test.info().annotations.push({
    type: 'intentional-failure',
    description: 'A NEW seed cannot be FILLED. Inspect the trace and DOM evidence.',
  });
  await tradeBlotterPage.viewOrder(seedIds.newOrder);
  await expect(authenticatedPage.getByTestId('detail-id')).toHaveText(seedIds.newOrder);
  // Deliberately false: normal suite excludes this entire directory.
  await expect(authenticatedPage.getByTestId('detail-status')).toHaveText('FILLED', {
    timeout: 2_000,
  });
});
