import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { computeUrl } from './compute-host.js';

process.env.E2E_PREVIEW = '1';

function resolveBaseUrl() {
  if (process.env.E2E_BASE_URL) {
    // Transform the base URL to add -preview suffix to the branch label
    // e.g., https://repo.branch.domain -> https://repo.branch-preview.domain
    const url = new URL(process.env.E2E_BASE_URL);
    const parts = url.hostname.split('.');
    if (parts.length >= 3) {
      parts[1] = `${parts[1]}-preview`;
      url.hostname = parts.join('.');
    }
    return url.toString().replace(/\/$/, '');
  }
  return computeUrl();
}

function resolveRepoRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
}

export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: resolveBaseUrl(),
    ignoreHTTPSErrors: true,
  },
  webServer: {
    command: 'npm run build --workspace playground && npm run serve --workspace playground',
    cwd: resolveRepoRoot(),
    url: resolveBaseUrl(),
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
    stdout: 'pipe',
    stderr: 'pipe',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
