import type { PluginOption } from 'vite';
import chalk from 'chalk';
import { execSync } from 'node:child_process';
import path from 'node:path';
import {
  validateCaddyIsInstalled,
  isCaddyRunning,
  startCaddy,
  ensureBaseConfig,
  addRoute,
  addTlsPolicy,
  removeRoute,
  removeTlsPolicy,
} from './utils.js';

export interface ViteCaddyTlsPluginOptions {
  /** Explicit domain to proxy without repo/branch derivation */
  domain?: string;
  /** Base domain to build <repo>.<branch>.<baseDomain> (defaults to localhost) */
  baseDomain?: string;
  /** Override repo name used in derived domains */
  repo?: string;
  /** Override branch name used in derived domains */
  branch?: string;
  cors?: string;
  /** Override the default Caddy server name (srv0) */
  serverName?: string;
  /** Use Caddy's internal CA for the provided domains (defaults to true when baseDomain or domain is set) */
  internalTls?: boolean;
}

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
  } catch (e) {
    // Ignore, fall back to explicit config
  }

  try {
    let branch = execGit('git rev-parse --abbrev-ref HEAD');
    if (branch === 'HEAD') {
      branch = execGit('git rev-parse --short HEAD');
    }
    if (branch) {
      info.branch = branch;
    }
  } catch (e) {
    // Ignore, fall back to explicit config
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

function buildDerivedDomain(options: ViteCaddyTlsPluginOptions) {
  const baseDomain = normalizeBaseDomain(options.baseDomain ?? 'localhost');
  if (!baseDomain) return null;

  let repo = options.repo;
  let branch = options.branch;

  if (!repo || !branch) {
    const info = getGitRepoInfo();
    if (!repo) repo = info.repo;
    if (!branch) branch = info.branch;
  }

  if (!repo || !branch) return null;

  const repoLabel = sanitizeDomainLabel(repo);
  const branchLabel = sanitizeDomainLabel(branch);

  if (!repoLabel || !branchLabel) return null;

  return `${repoLabel}.${branchLabel}.${baseDomain}`;
}

function normalizeDomain(domain: string) {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed;
}

function resolveDomain(options: ViteCaddyTlsPluginOptions) {
  if (options.domain) {
    return normalizeDomain(options.domain);
  }

  return buildDerivedDomain(options);
}

/**
 * Vite plugin to run Caddy server to proxy traffic on https for local development
 *
 * @param {@link ViteCaddyTlsPluginOptions} config - the config to pass to the plugin
 * @example
 * ```
 * caddyTls({
 *   domain: "app.localhost",
 * })
 * ```
 * @returns {Plugin} - a Vite plugin
 */
export default function viteCaddyTlsPlugin(
  {
    domain,
    baseDomain,
    repo,
    branch,
    cors,
    serverName,
    internalTls,
  }: ViteCaddyTlsPluginOptions = {},
): PluginOption {
  return {
    name: 'vite:caddy-tls',
    configureServer({ httpServer, config }) {
      const fallbackPort = config.server.port || 5173;
      const resolvedDomain = resolveDomain({ domain, baseDomain, repo, branch });
      const domainArray = resolvedDomain ? [resolvedDomain] : [];
      const routeId = `vite-proxy-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const shouldUseInternalTls =
        internalTls ?? (baseDomain !== undefined || domain !== undefined);
      const tlsPolicyId = shouldUseInternalTls ? `${routeId}-tls` : null;
      let cleanupStarted = false;

      if (domainArray.length === 0) {
        console.error(
          chalk.red(
            'No domain resolved. Provide domain, or run inside a git repo, or pass repo/branch.',
          ),
        );
        return;
      }
      let tlsPolicyAdded = false;

      function getServerPort() {
        if (!httpServer) return fallbackPort;
        const address = httpServer.address();
        if (address && typeof address === 'object' && 'port' in address) {
          return address.port;
        }
        return fallbackPort;
      }

      async function cleanupRoute() {
        if (cleanupStarted) return;
        cleanupStarted = true;
        if (tlsPolicyId) {
          await removeTlsPolicy(tlsPolicyId);
        }
        await removeRoute(routeId);
      }

      function onServerClose() {
        void cleanupRoute();
      }

      function handleSignal(signal: NodeJS.Signals) {
        process.off('SIGINT', onSigint);
        process.off('SIGTERM', onSigterm);
        void cleanupRoute().finally(() => {
          process.kill(process.pid, signal);
        });
      }

      function onSigint() {
        handleSignal('SIGINT');
      }

      function onSigterm() {
        handleSignal('SIGTERM');
      }

      function registerProcessCleanup() {
        process.once('SIGINT', onSigint);
        process.once('SIGTERM', onSigterm);
      }

      async function setupRoute() {
        if (!validateCaddyIsInstalled()) {
          return;
        }

        // 1. Ensure Caddy is running
        let running = await isCaddyRunning();
        if (!running) {
          running = await startCaddy();
          if (!running) {
            console.error(chalk.red('Failed to start Caddy server.'));
            return;
          }
        }

        // 2. Ensure base configuration exists
        try {
          await ensureBaseConfig(serverName);
        } catch (e) {
          console.error(chalk.red('Failed to configure Caddy base settings.'), e);
          return;
        }

        const port = getServerPort();

        // 3. Add the specific route for this app
        if (tlsPolicyId) {
          try {
            await addTlsPolicy(tlsPolicyId, domainArray);
            tlsPolicyAdded = true;
          } catch (e) {
            console.error(chalk.red('Failed to add TLS policy to Caddy.'), e);
            return;
          }
        }

        try {
          await addRoute(routeId, domainArray, port, cors, serverName);
        } catch (e) {
          if (tlsPolicyAdded && tlsPolicyId) {
            await removeTlsPolicy(tlsPolicyId);
          }
          console.error(chalk.red('Failed to add route to Caddy.'), e);
          return;
        }

        console.log();
        console.log(chalk.green('🔒 Caddy is proxying your traffic on https'));

        console.log();
        console.log(
          `🔗 Access your local ${domainArray.length > 1 ? 'servers' : 'server'} `,
        );

        domainArray.forEach((domain) => {
          console.log(chalk.blue(`🌍 https://${domain}`));
        });

        console.log();

        // 4. Remove route on close or process exit
        registerProcessCleanup();
        httpServer?.once('close', onServerClose);
      }

      function onListening() {
        void setupRoute();
      }

      if (httpServer?.listening) {
        void setupRoute();
      } else if (httpServer) {
        httpServer.once('listening', onListening);
      } else {
        void setupRoute();
      }
    },
  };
}
