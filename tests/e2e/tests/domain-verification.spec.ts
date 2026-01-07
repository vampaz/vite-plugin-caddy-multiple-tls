import { test, expect } from '@playwright/test';
import { computeHost } from '../compute-host.js';

test('is served on the expected domain', async ({ page }) => {
  const expectedHost = computeHost();
  await page.goto('/');
  const url = new URL(page.url());
  expect(url.hostname).toBe(expectedHost);
});
