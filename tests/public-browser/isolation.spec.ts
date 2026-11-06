import { test, expect } from '@playwright/test';
import { publicBrowser } from '../public-demo/http-fixture.js';

test('native browser fixtures preserve the default request limit and isolate sessions and counters', async ({
  request,
}) => {
  const first = await publicBrowser();
  let second: Awaited<ReturnType<typeof publicBrowser>> | undefined;
  try {
    const login = await request.post(first.origin + '/api/session', {
      data: { username: 'qa.user', password: 'Password123!' },
    });
    expect(login.status()).toBe(200);
    const oldToken = ((await login.json()) as { token: string }).token;
    let limited = false;
    for (let index = 0; index < 601; index++) {
      const response = await request.get(first.origin + '/api/orders');
      if (response.status() === 429) {
        expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
          'RATE_LIMITED',
        );
        limited = true;
        break;
      }
      expect(response.status()).toBe(401);
    }
    expect(limited).toBe(true);
    expect((await request.get(first.origin + '/health')).status()).toBe(200);
    expect((await request.get(first.origin + '/app.js')).status()).toBe(429);
    second = await publicBrowser();
    expect((await request.get(second.origin + '/app.js')).status()).toBe(200);
    expect(
      (
        await request.get(second.origin + '/api/orders', {
          headers: { Authorization: 'Bearer ' + oldToken },
        })
      ).status(),
    ).toBe(401);
  } finally {
    await second?.close();
    await first.close();
  }
});
