import type { PluginOption } from 'vite';
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
  /** Optional loopback domain to avoid /etc/hosts edits */
  loopbackDomain?: LoopbackDomain;
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

type LoopbackDomain = 'localtest.me' | 'lvh.me' | 'nip.io';

const LOOPBACK_DOMAINS: Record<LoopbackDomain, string> = {
  'localtest.me': 'localtest.me',
  'lvh.me': 'lvh.me',
  'nip.io': '127.0.0.1.nip.io',
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

function resolveBaseDomain(options: ViteCaddyTlsPluginOptions) {
  if (options.baseDomain !== undefined) {
    return normalizeBaseDomain(options.baseDomain);
  }

  if (options.loopbackDomain) {
    return normalizeBaseDomain(LOOPBACK_DOMAINS[options.loopbackDomain]);
  }

  return 'localhost';
}

function resolveUpstreamHost(host: string | boolean | undefined) {
  if (typeof host === 'string') {
    const trimmed = host.trim();
    if (trimmed && trimmed !== '0.0.0.0' && trimmed !== '::') {
      return trimmed;
    }
  }

  return '127.0.0.1';
}
function sanitizeDomainLabel(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildDerivedDomain(options: ViteCaddyTlsPluginOptions) {
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
    loopbackDomain,
    repo,
    branch,
    cors,
    serverName,
    internalTls,
  }: ViteCaddyTlsPluginOptions = {},
): PluginOption {
  return {
    name: 'vite:caddy-tls',
    configureServer(server) {
      const { httpServer, config } = server;
      const fallbackPort = config.server.port || 5173;
      const resolvedDomain = resolveDomain({
        domain,
        baseDomain,
        loopbackDomain,
        repo,
        branch,
      });
      const domainArray = resolvedDomain ? [resolvedDomain] : [];
      const routeId = `vite-proxy-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      const shouldUseInternalTls =
        internalTls ??
        (baseDomain !== undefined || loopbackDomain !== undefined || domain !== undefined);
      const tlsPolicyId = shouldUseInternalTls ? `${routeId}-tls` : null;
      let cleanupStarted = false;
      let resolvedPort: number | null = null;
      let resolvedHost: string | null = null;
      let setupStarted = false;

      if (domainArray.length === 0) {
        console.error(
          'No domain resolved. Provide domain, or run inside a git repo, or pass repo/branch.',
        );
        return;
      }
      let tlsPolicyAdded = false;

      function getPortFromAddress(address: unknown) {
        if (address && typeof address === 'object' && 'port' in address) {
          const port = (address as { port: unknown }).port;
          if (typeof port === 'number') {
            return port;
          }
        }
        return null;
      }

      function updateResolvedTarget() {
        if (resolvedPort !== null && resolvedHost !== null) return;

        const resolvedUrl = server.resolvedUrls?.local?.[0];
        if (resolvedUrl) {
          try {
            const url = new URL(resolvedUrl);
            if (resolvedHost === null && url.hostname) {
              resolvedHost = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
            }
            const port = Number(url.port);
            if (resolvedPort === null && !Number.isNaN(port)) {
              resolvedPort = port;
            }
          } catch (e) {
            // Ignore URL parsing errors
          }
        }

        if (httpServer) {
          const address = httpServer.address();
          if (address && typeof address === 'object') {
            const port = getPortFromAddress(address);
            if (resolvedPort === null && port !== null) {
              resolvedPort = port;
            }
            if (resolvedHost === null && 'address' in address) {
              const host = (address as { address?: unknown }).address;
              if (
                typeof host === 'string' &&
                host !== '0.0.0.0' &&
                host !== '::'
              ) {
                resolvedHost = host;
              }
            }
          }
        }

        if (resolvedPort === null && typeof config.server.port === 'number') {
          resolvedPort = config.server.port;
        }
        if (resolvedHost === null) {
          resolvedHost = resolveUpstreamHost(config.server.host);
        }
      }

      function getServerPort() {
        updateResolvedTarget();
        return resolvedPort ?? fallbackPort;
      }

      function getUpstreamHost() {
        updateResolvedTarget();
        return resolvedHost ?? '127.0.0.1';
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
            console.error('Failed to start Caddy server.');
            return;
          }
        }

        // 2. Ensure base configuration exists
        try {
          await ensureBaseConfig(serverName);
        } catch (e) {
          console.error('Failed to configure Caddy base settings.', e);
          return;
        }

        const port = getServerPort();
        const upstreamHost = getUpstreamHost();

        // 3. Add the specific route for this app
        if (tlsPolicyId) {
          try {
            await addTlsPolicy(tlsPolicyId, domainArray);
            tlsPolicyAdded = true;
          } catch (e) {
            console.error('Failed to add TLS policy to Caddy.', e);
            return;
          }
        }

        try {
          await addRoute(routeId, domainArray, port, cors, serverName, upstreamHost);
        } catch (e) {
          if (tlsPolicyAdded && tlsPolicyId) {
            await removeTlsPolicy(tlsPolicyId);
          }
          console.error('Failed to add route to Caddy.', e);
          return;
        }

        console.log();
        console.log('🔒 Caddy is proxying your traffic on https');

        console.log();
        console.log(
          `🔗 Access your local ${domainArray.length > 1 ? 'servers' : 'server'}!`,
        );

        domainArray.forEach((domain) => {
          console.log(`🌍 https://${domain}`);
        });

        if (process.platform === 'linux' && !loopbackDomain) {
          console.log();
          console.log('🐧 Linux users: if the domain doesn\'t resolve, run:');
          domainArray.forEach((domain) => {
            console.log(`   echo "127.0.0.1 ${domain}" | sudo tee -a /etc/hosts`);
          });
        }

        console.log();

        // 4. Remove route on close or process exit
        registerProcessCleanup();
        httpServer?.once('close', onServerClose);
      }

      function runSetupOnce() {
        if (setupStarted) return;
        setupStarted = true;
        void setupRoute();
      }

      function wrapServerListen() {
        if (typeof server.listen !== 'function') return false;
        const originalListen = server.listen.bind(server);
        server.listen = async function (port?: number, isRestart?: boolean) {
          const result = await originalListen(port, isRestart);
          if (typeof port === 'number') {
            resolvedPort = port;
          } else {
            updateResolvedTarget();
          }
          runSetupOnce();
          return result;
        };
        return true;
      }

      function onListening() {
        updateResolvedTarget();
        runSetupOnce();
      }

      const listenWrapped = wrapServerListen();
      if (httpServer?.listening) {
        runSetupOnce();
      } else if (httpServer) {
        httpServer.once('listening', onListening);
      } else if (!listenWrapped) {
        runSetupOnce();
      }
    },
  };
}
