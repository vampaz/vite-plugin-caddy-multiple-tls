import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOOPBACK_DOMAINS,
  getGitRepoInfo,
  resolveCaddyTlsDomains,
  resolveCaddyTlsUrl,
} from "../../packages/plugin/src/domain-resolution.js";

function getPlaygroundBaseDomain() {
  const baseDomainPath = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../playground/base-domain.ts",
  );
  const content = readFileSync(baseDomainPath, "utf8");
  const match = content.match(/['"]([^'"]+)['"]/);
  if (!match) {
    throw new Error("Could not parse playground base domain");
  }
  return match[1];
}

function resolveE2eOptions() {
  const e2eDomain = process.env.E2E_DOMAIN;
  const e2eLoopbackDomain = process.env.E2E_LOOPBACK_DOMAIN;
  let baseDomain = process.env.E2E_BASE_DOMAIN;
  let loopbackDomain;

  if (!baseDomain && e2eLoopbackDomain && LOOPBACK_DOMAINS[e2eLoopbackDomain]) {
    loopbackDomain = e2eLoopbackDomain;
  }

  if (!baseDomain && !e2eLoopbackDomain) {
    baseDomain = getPlaygroundBaseDomain();
  }

  const options = {
    domain: e2eDomain,
    baseDomain,
    loopbackDomain,
  };

  if (process.env.E2E_PREVIEW) {
    const gitInfo = getGitRepoInfo();
    if (!gitInfo.repo || !gitInfo.branch) {
      throw new Error("Could not derive repo/branch.");
    }
    options.repo = gitInfo.repo;
    options.branch = `${gitInfo.branch}-preview`;
  }

  return options;
}

export function computeHost() {
  const domains = resolveCaddyTlsDomains(resolveE2eOptions());

  if (!domains || domains.length !== 1) {
    throw new Error("Could not resolve E2E host.");
  }

  return domains[0];
}

export function computeUrl() {
  const url = resolveCaddyTlsUrl(resolveE2eOptions());

  if (!url) {
    throw new Error("Could not resolve E2E URL.");
  }

  return url;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = computeHost();
  console.log(`host=${host}`);
  console.log(`url=https://${host}`);
}
