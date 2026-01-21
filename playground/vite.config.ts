import { defineConfig } from 'vite';
import { execSync } from 'node:child_process';
import caddyTls from '../packages/plugin/src/index.js';
import { playgroundBaseDomain } from './base-domain.js';

type LoopbackDomain = 'localtest.me' | 'lvh.me' | 'nip.io';

const VALID_LOOPBACK_DOMAINS: LoopbackDomain[] = ['localtest.me', 'lvh.me', 'nip.io'];

function isLoopbackDomain(value: string | undefined): value is LoopbackDomain {
  return VALID_LOOPBACK_DOMAINS.includes(value as LoopbackDomain);
}

const e2eDomain = process.env.E2E_DOMAIN;
const e2eBaseDomain = process.env.E2E_BASE_DOMAIN;
const e2eLoopbackDomain = process.env.E2E_LOOPBACK_DOMAIN;
const e2ePreview = process.env.E2E_PREVIEW;

// Default to playgroundBaseDomain only if no E2E override is present
const shouldUseDefaultBase = !e2eDomain && !e2eBaseDomain && !e2eLoopbackDomain;

function getGitBranch() {
  try {
    let branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
    if (branch === 'HEAD') {
      branch = execSync('git rev-parse --short HEAD').toString().trim();
    }
    return branch;
  } catch {
    return null;
  }
}

let branch: string | undefined;
if (e2ePreview) {
  const currentBranch = getGitBranch();
  if (currentBranch) {
    branch = `${currentBranch}-preview`;
  }
}

const config = defineConfig({
  // server: {
  //   port: 3000,
  //   host: true,
  //   allowedHosts: true,
  // },
  // preview: {
  //   port: 4173,
  //   host: true,
  // },
  plugins: [
    caddyTls({
      domain: e2eDomain,
      baseDomain: e2eBaseDomain || (shouldUseDefaultBase ? playgroundBaseDomain : undefined),
      loopbackDomain: isLoopbackDomain(e2eLoopbackDomain) ? e2eLoopbackDomain : undefined,
      branch,
    }),
  ],
});

export default config;
