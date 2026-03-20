import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCaddyTlsDomains, resolveCaddyTlsUrl } from "../../packages/plugin/src/index.js";

const LOOPBACK_DOMAINS = ["localtest.me", "lvh.me", "nip.io"] as const;

type LoopbackDomain = (typeof LOOPBACK_DOMAINS)[number];

function execGit(command: string) {
  return execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

function getPlaygroundBaseDomain() {
  const baseDomainPath = path.resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "../../playground/base-domain.ts",
  );
  const content = readFileSync(baseDomainPath, "utf8");
  const match = content.match(/'([^']+)'/);
  if (!match) {
    throw new Error("Could not parse playground base domain");
  }
  return match[1];
}

function resolveLoopbackDomain(value: string | undefined): LoopbackDomain | undefined {
  if (!value) return undefined;
  if (LOOPBACK_DOMAINS.includes(value as LoopbackDomain)) {
    return value as LoopbackDomain;
  }
  return undefined;
}

function getGitBranch() {
  try {
    let branch = execGit("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") {
      branch = execGit("git rev-parse --short HEAD");
    }
    return branch || undefined;
  } catch (error) {
    return undefined;
  }
}

function resolveOptions() {
  const domain = process.env.E2E_DOMAIN;
  let baseDomain = process.env.E2E_BASE_DOMAIN;
  const loopbackDomain = resolveLoopbackDomain(process.env.E2E_LOOPBACK_DOMAIN);

  if (!domain && !baseDomain && !loopbackDomain) {
    baseDomain = getPlaygroundBaseDomain();
  }

  let branch: string | undefined;

  if (process.env.E2E_PREVIEW) {
    const currentBranch = getGitBranch();
    if (currentBranch) {
      branch = `${currentBranch}-preview`;
    }
  }

  return {
    domain,
    baseDomain,
    loopbackDomain,
    branch,
  };
}

export function computeHost() {
  const domains = resolveCaddyTlsDomains(resolveOptions());
  if (!domains || domains.length !== 1) {
    throw new Error("Could not resolve a single E2E host.");
  }
  return domains[0];
}

export function computeUrl() {
  const url = resolveCaddyTlsUrl(resolveOptions());
  if (!url) {
    throw new Error("Could not resolve a single E2E URL.");
  }
  return url;
}
