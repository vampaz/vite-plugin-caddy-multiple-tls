import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { computeUrl } from './compute-host.js';

process.env.E2E_PREVIEW = '1';

function resolveBaseUrl() {
  if (process.env.E2E_BASE_URL) {
    return process.env.E2E_BASE_URL;
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
