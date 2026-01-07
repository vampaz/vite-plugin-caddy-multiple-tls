import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LOOPBACK_DOMAINS = {
  'localtest.me': 'localtest.me',
  'lvh.me': 'lvh.me',
  'nip.io': '127.0.0.1.nip.io',
};

function execGit(command) {
  return execSync(command, { stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

function normalizeBaseDomain(baseDomain) {
  return baseDomain.trim().replace(/^\.+|\.+$/g, '').toLowerCase();
}

function normalizeDomain(domain) {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed;
}

function sanitizeDomainLabel(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getPlaygroundBaseDomain() {
  const baseDomainPath = path.resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../playground/base-domain.ts'
  );
  const content = readFileSync(baseDomainPath, 'utf8');
  const match = content.match(/'([^']+)'/);
  if (!match) {
    throw new Error('Could not parse playground base domain');
  }
  return match[1];
}

export function computeHost() {
  const e2eDomain = process.env.E2E_DOMAIN;
  if (e2eDomain) {
    const normalized = normalizeDomain(e2eDomain);
    if (!normalized) throw new Error('E2E_DOMAIN is invalid');
    return normalized;
  }

  const e2eLoopbackDomain = process.env.E2E_LOOPBACK_DOMAIN;
  let baseDomain = process.env.E2E_BASE_DOMAIN;

  if (!baseDomain && e2eLoopbackDomain && LOOPBACK_DOMAINS[e2eLoopbackDomain]) {
    baseDomain = LOOPBACK_DOMAINS[e2eLoopbackDomain];
  }

  if (!baseDomain && !e2eLoopbackDomain) {
    baseDomain = getPlaygroundBaseDomain();
  }

  baseDomain = normalizeBaseDomain(baseDomain ?? 'localhost');

  if (!baseDomain) {
    throw new Error('Playground base domain is empty.');
  }

  let repo;
  let branch;

  try {
    const repoRoot = execGit('git rev-parse --show-toplevel');
    if (repoRoot) {
      repo = path.basename(repoRoot);
    }
  } catch (error) {
    // Ignore
  }

  try {
    branch = execGit('git rev-parse --abbrev-ref HEAD');
    if (branch === 'HEAD') {
      branch = execGit('git rev-parse --short HEAD');
    }
  } catch (error) {
    // Ignore
  }

  if (!repo || !branch) {
    throw new Error('Could not derive repo/branch.');
  }

  const repoLabel = sanitizeDomainLabel(repo);
  const branchLabel = sanitizeDomainLabel(branch);

  if (!repoLabel || !branchLabel) {
    throw new Error('Derived repo/branch are empty.');
  }

  if (process.env.E2E_PREVIEW) {
    return `${repoLabel}.${branchLabel}-preview.${baseDomain}`;
  }

  return `${repoLabel}.${branchLabel}.${baseDomain}`;
}

export function computeUrl() {
  return `https://${computeHost()}`;
}

// If run directly, output the host
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = computeHost();
  console.log(`host=${host}`);
  console.log(`url=https://${host}`);
}
