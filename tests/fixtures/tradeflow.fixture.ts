import { test as base, expect, type APIRequestContext, type Page } from '@playwright/test';
import { z } from 'zod';
import {
  orderResponseSchema,
  sessionResponseSchema,
  type CreateOrderInput,
  type Order,
} from '../../app/domain/schemas.js';
import { TradeBlotterPage } from '../../pages/TradeBlotterPage.js';
import { buildOrder } from '../../test-data/factories/order.factory.js';
import { credentials } from '../../test-data/fixtures/reference-data.js';

const healthSchema = z
  .object({
    status: z.literal('ok'),
    service: z.literal('TradeFlow Lab'),
    synthetic: z.literal(true),
  })
  .strict();

type Session = z.infer<typeof sessionResponseSchema>;
type Environment = Readonly<{ baseURL: string; health: Readonly<z.infer<typeof healthSchema>> }>;
type TestFixtures = {
  authSession: Session;
  apiClient: APIRequestContext;
  authenticatedPage: Page;
  orderFactory: (overrides?: Partial<CreateOrderInput>) => Promise<Order>;
  tradeBlotterPage: TradeBlotterPage;
};
type WorkerFixtures = { environment: Environment };

export const test = base.extend<TestFixtures, WorkerFixtures>({
  environment: [
    async ({ playwright }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (typeof baseURL !== 'string')
        throw new Error('A baseURL is required for TradeFlow tests.');
      const probe = await playwright.request.newContext({ baseURL });
      let health: z.infer<typeof healthSchema>;
      try {
        const response = await probe.get('/health');
        expect(
          response.status(),
          'The local lab must be ready before fixtures create sessions',
        ).toBe(200);
        health = healthSchema.parse(await response.json());
      } finally {
        await probe.dispose();
      }
      // Only immutable environment facts are shared. Tokens and books stay test scoped.
      await use(Object.freeze({ baseURL, health: Object.freeze(health) }));
    },
    { scope: 'worker' },
  ],

  authSession: async ({ playwright, environment }, use) => {
    const setup = await playwright.request.newContext({ baseURL: environment.baseURL });
    let session: Session | undefined;
    try {
      const response = await setup.post('/api/session', { data: credentials.trader });
      expect(response.status(), 'Fixture authentication must succeed').toBe(200);
      session = sessionResponseSchema.parse(await response.json());
      await use(session);
    } finally {
      try {
        if (session) {
          const cleanup = await setup.delete('/api/session', {
            headers: { Authorization: `Bearer ${session.token}` },
          });
          expect(cleanup.status(), 'Fixture teardown must release its session').toBe(204);
        }
      } finally {
        await setup.dispose();
      }
    }
  },

  // Built-in context/page consume this in-memory state and retain Playwright tracing/video.
  // Login tests import the built-in test instead so they start without authentication.
  storageState: async ({ authSession, environment }, use) => {
    await use({
      cookies: [],
      origins: [
        {
          origin: new URL(environment.baseURL).origin,
          localStorage: [{ name: 'tradeflow.token', value: authSession.token }],
        },
      ],
    });
  },

  apiClient: async ({ playwright, authSession, environment }, use) => {
    const client = await playwright.request.newContext({
      baseURL: environment.baseURL,
      extraHTTPHeaders: { Authorization: `Bearer ${authSession.token}` },
    });
    try {
      await use(client);
    } finally {
      await client.dispose();
    }
  },

  authenticatedPage: async ({ page }, use) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Order blotter', exact: true })).toBeVisible();
    await use(page);
  },

  orderFactory: async ({ apiClient }, use) => {
    await use(async (overrides = {}) => {
      const input = buildOrder(overrides);
      const response = await apiClient.post('/api/orders', { data: input });
      expect(
        response.status(),
        'Order setup must create a record, rather than hide a failed request',
      ).toBe(201);
      const { order } = orderResponseSchema.parse(await response.json());
      expect(order).toMatchObject({ ...input, status: 'NEW' });
      return order;
    });
    // Session teardown releases the entire generated book, including terminal records.
  },

  tradeBlotterPage: async ({ authenticatedPage }, use) => {
    await use(new TradeBlotterPage(authenticatedPage));
  },
});

export { expect };
