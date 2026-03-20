import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

const MAX_DOMAIN_LABEL_LENGTH = 63;
const DOMAIN_LABEL_HASH_LENGTH = 10;

export const LOOPBACK_DOMAINS = {
  "localtest.me": "localtest.me",
  "lvh.me": "lvh.me",
  "nip.io": "127.0.0.1.nip.io",
};

function execGit(command) {
  return execSync(command, { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

export function getGitRepoInfo() {
  const info = {};

  try {
    const repoRoot = execGit("git rev-parse --show-toplevel");
    if (repoRoot) {
      info.repo = path.basename(repoRoot);
    }
  } catch {
    // Ignore, fall back to explicit config
  }

  try {
    let branch = execGit("git rev-parse --abbrev-ref HEAD");
    if (branch === "HEAD") {
      branch = execGit("git rev-parse --short HEAD");
    }
    if (branch) {
      info.branch = branch;
    }
  } catch {
    // Ignore, fall back to explicit config
  }

  return info;
}

export function normalizeBaseDomain(baseDomain) {
  return baseDomain
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .toLowerCase();
}

export function resolveBaseDomain(options) {
  if (options.baseDomain !== undefined) {
    return normalizeBaseDomain(options.baseDomain);
  }

  if (options.loopbackDomain) {
    return normalizeBaseDomain(LOOPBACK_DOMAINS[options.loopbackDomain]);
  }

  return "localhost";
}

export function normalizeDomain(domain) {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed;
}

export function normalizeDomains(domains) {
  const domainList = Array.isArray(domains) ? domains : [domains];
  const normalized = domainList.map((domain) => normalizeDomain(domain)).filter(Boolean);
  if (normalized.length === 0) return null;
  return Array.from(new Set(normalized));
}

export function sanitizeDomainLabel(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function compactDomainLabel(value) {
  const sanitized = sanitizeDomainLabel(value);
  if (!sanitized) return "";
  if (sanitized.length <= MAX_DOMAIN_LABEL_LENGTH) {
    return sanitized;
  }

  const hash = createHash("sha1")
    .update(sanitized)
    .digest("hex")
    .slice(0, DOMAIN_LABEL_HASH_LENGTH);
  const prefixLength = MAX_DOMAIN_LABEL_LENGTH - hash.length - 1;
  const prefix = sanitized.slice(0, prefixLength).replace(/-+$/g, "");

  if (!prefix) {
    return hash;
  }

  return `${prefix}-${hash}`;
}

export function buildDerivedDomain(options) {
  const baseDomain = resolveBaseDomain(options);
  if (!baseDomain) return null;

  let repo = options.repo;
  let branch = options.branch;

  if (!repo || !branch) {
    const info = getGitRepoInfo();
    if (!repo) repo = info.repo;
    if (!branch) branch = info.branch;
  }

  if (!repo || !branch) return null;

  const repoLabel = compactDomainLabel(repo);
  const branchLabel = compactDomainLabel(branch);

  if (!repoLabel || !branchLabel) return null;

  const labels = [repoLabel, branchLabel];
  if (options.instanceLabel !== undefined) {
    const instanceLabel = compactDomainLabel(options.instanceLabel);
    if (!instanceLabel) return null;
    labels.push(instanceLabel);
  }

  return `${labels.join(".")}.${baseDomain}`;
}

export function resolveCaddyTlsDomains(options = {}) {
  if (options.domain) {
    return normalizeDomains(options.domain);
  }

  const derivedDomain = buildDerivedDomain(options);
  if (!derivedDomain) return null;
  return [derivedDomain];
}

export function resolveCaddyTlsUrl(options = {}) {
  const domains = resolveCaddyTlsDomains(options);
  if (!domains || domains.length !== 1) return null;
  return `https://${domains[0]}`;
}
