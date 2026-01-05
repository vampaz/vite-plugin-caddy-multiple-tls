import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { playgroundBaseDomain } from '../../playground/base-domain.js';

type GitInfo = {
  repo?: string;
  branch?: string;
};

function execGit(command: string) {
  return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function getGitRepoInfo(): GitInfo {
  const info: GitInfo = {};

  try {
    const repoRoot = execGit('git rev-parse --show-toplevel');
    if (repoRoot) {
      info.repo = path.basename(repoRoot);
    }
  } catch (error) {
    // Ignore and fall back to env overrides.
  }

  try {
    let branch = execGit('git rev-parse --abbrev-ref HEAD');
    if (branch === 'HEAD') {
      branch = execGit('git rev-parse --short HEAD');
    }
    if (branch) {
      info.branch = branch;
    }
  } catch (error) {
    // Ignore and fall back to env overrides.
  }

  return info;
}

function normalizeBaseDomain(baseDomain: string) {
  return baseDomain.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
}

function sanitizeDomainLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveBaseUrl() {
  if (process.env.E2E_BASE_URL) {
    return process.env.E2E_BASE_URL;
  }

  const baseDomain = normalizeBaseDomain(playgroundBaseDomain ?? 'localhost');
  if (!baseDomain) {
    throw new Error('Playground base domain is empty.');
  }

  const info = getGitRepoInfo();
  if (!info.repo || !info.branch) {
    throw new Error(
      'Could not derive repo/branch for e2e URL. Set E2E_BASE_URL instead.',
    );
  }

  const repoLabel = sanitizeDomainLabel(info.repo);
  const branchLabel = sanitizeDomainLabel(info.branch);

  if (!repoLabel || !branchLabel) {
    throw new Error(
      'Derived repo/branch are empty. Set E2E_BASE_URL instead.',
    );
  }

  return `https://${repoLabel}.${branchLabel}.${baseDomain}`;
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
    command: 'npm run dev --workspace playground',
    cwd: resolveRepoRoot(),
    url: resolveBaseUrl(),
    reuseExistingServer: true,
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
