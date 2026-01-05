import { test, expect } from '@playwright/test';

test('renders the playground content', async function ({ page }) {
  await page.goto('/');
  await page.waitForSelector('h1');

  await expect(
    page.getByRole('heading', { name: 'Vite Plugin Caddy with multiple TLS' }),
  ).toBeVisible();
  await expect(
    page.getByText(
      'This page is served over HTTPS using Caddy server to self-sign certificates.',
    ),
  ).toBeVisible();
});

test('shows the resolved location and tags', async function ({ page }) {
  await page.goto('/');
  await page.waitForSelector('#location');

  const location = page.locator('#location');
  await expect(location).toContainText('You are using:');

  await page.waitForSelector('.chips span');
  await expect(page.locator('.chips span')).toHaveCount(3);
});
