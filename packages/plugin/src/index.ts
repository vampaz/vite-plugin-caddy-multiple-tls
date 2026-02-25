import type { PluginOption, PreviewServer, ResolvedConfig, ViteDevServer } from 'vite';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  validateCaddyIsInstalled,
  ensureCaddyReady,
  addRoute,
  addTlsPolicy,
  cleanupStaleRoutesForDomains,
  removeRoute,
  removeTlsPolicy,
  DEFAULT_CADDY_API_URL,
} from './utils.js';

export interface ViteCaddyTlsPluginOptions {
  /** Explicit domain to proxy without repo/branch derivation */
  domain?: string | string[];
  /** Base domain to build <repo>.<branch>.<baseDomain> (defaults to localhost) */
  baseDomain?: string;
  /** Optional loopback domain to avoid /etc/hosts edits */
  loopbackDomain?: LoopbackDomain;
  /** Override repo name used in derived domains */
  repo?: string;
  /** Override branch name used in derived domains */
  branch?: string;
  /** Extra unique label appended after branch in derived domains */
  instanceLabel?: string;
  cors?: string;
  /** Override the default Caddy server name (srv0) */
  serverName?: string;
  /** Override the Caddy Admin API base URL (default: http://localhost:2019) */
  caddyApiUrl?: string;
  /** Override the Origin header used for Caddy Admin API requests (defaults to caddyApiUrl origin) */
  caddyAdminOrigin?: string;
  /** Use Caddy's internal CA for the provided domains (defaults to true when baseDomain or domain is set) */
  internalTls?: boolean;
  /**
   * Override the Host header sent to the Vite dev server.
   * Useful when upstream middleware (e.g. Wrangler/Miniflare) only accepts localhost hosts.
   */
  upstreamHostHeader?: string;
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

  const labels = [repoLabel, branchLabel];
  if (options.instanceLabel !== undefined) {
    const instanceLabel = sanitizeDomainLabel(options.instanceLabel);
    if (!instanceLabel) return null;
    labels.push(instanceLabel);
  }

  return `${labels.join('.')}.${baseDomain}`;
}

function normalizeDomain(domain: string) {
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed;
}

function normalizeDomains(domains: string | string[]) {
  const domainList = Array.isArray(domains) ? domains : [domains];
  const normalized = domainList
    .map((domain) => normalizeDomain(domain))
    .filter((domain): domain is string => Boolean(domain));
  if (normalized.length === 0) return null;
  return Array.from(new Set(normalized));
}

function normalizeCaddyApiUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/g, '');
}

function normalizeCaddyAdminOrigin(origin: string) {
  const trimmed = origin.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).origin;
  } catch (e) {
    return null;
  }
}

function resolveDomains(options: ViteCaddyTlsPluginOptions) {
  if (options.domain) {
    return normalizeDomains(options.domain);
  }

  const derivedDomain = buildDerivedDomain(options);
  if (!derivedDomain) return null;
  return [derivedDomain];
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
    instanceLabel,
    cors,
    serverName,
    caddyApiUrl,
    caddyAdminOrigin,
    internalTls,
    upstreamHostHeader,
  }: ViteCaddyTlsPluginOptions = {},
): PluginOption {
  const normalizedApiUrl = caddyApiUrl ? normalizeCaddyApiUrl(caddyApiUrl) : null;
  const pluginCaddyApiUrl = normalizedApiUrl ?? DEFAULT_CADDY_API_URL;
  const normalizedAdminOrigin = caddyAdminOrigin
    ? normalizeCaddyAdminOrigin(caddyAdminOrigin)
    : null;
  const pluginCaddyAdminOrigin = normalizedAdminOrigin ?? pluginCaddyApiUrl;
  if (caddyApiUrl !== undefined && !normalizedApiUrl) {
    console.warn(
      `caddyApiUrl is empty after trimming. Falling back to ${DEFAULT_CADDY_API_URL}.`,
    );
  }
  if (caddyAdminOrigin !== undefined && !normalizedAdminOrigin) {
    console.warn(
      `caddyAdminOrigin is invalid. Falling back to ${pluginCaddyApiUrl}.`,
    );
  }

  function getInstanceKey(domains: string[], configRoot?: string) {
    const keyMaterial = JSON.stringify({
      domains: [...domains].sort(),
      cwd: process.cwd(),
      root: configRoot ?? null,
    });

    return createHash('sha1').update(keyMaterial).digest('hex').slice(0, 12);
  }

  function isPreviewServer(server: ViteDevServer | PreviewServer) {
    return server.config.isProduction;
  }

  function getPreviewPort(config: ResolvedConfig) {
    if (typeof config.preview?.port === 'number') {
      return config.preview.port;
    }
    return null;
  }

  function getPreviewHost(config: ResolvedConfig) {
    if (config.preview && 'host' in config.preview) {
      return resolveUpstreamHost(config.preview.host);
    }
    return null;
  }

  function hasListen(server: unknown): server is {
    listen: (port?: number, isRestart?: boolean) => Promise<unknown>;
  } {
    return (
      !!server &&
      typeof server === 'object' &&
      'listen' in server &&
      typeof (server as { listen?: unknown }).listen === 'function'
    );
  }

  function setupServer(server: ViteDevServer | PreviewServer) {
    const { httpServer, config } = server;
    const previewMode = isPreviewServer(server);
    const fallbackPort = previewMode
      ? getPreviewPort(config) ?? 4173
      : config.server.port || 5173;
    const resolvedDomains = resolveDomains({
      domain,
      baseDomain,
      loopbackDomain,
      repo,
      branch,
      instanceLabel,
    });
    const domainArray = resolvedDomains ?? [];
    const routeId = `vite-proxy-${getInstanceKey(domainArray, config.root)}`;
    const shouldUseInternalTls =
      internalTls ??
      (baseDomain !== undefined || loopbackDomain !== undefined || domain !== undefined);
    const tlsPolicyId = shouldUseInternalTls ? `${routeId}-tls` : null;
    let cleanupStarted = false;
    let resolvedPort: number | null = null;
    let resolvedHost: string | null = null;
    let setupStarted = false;

    function buildDomainResolutionMessage() {
      const issues: string[] = [];
      if (domain !== undefined && !normalizeDomains(domain)) {
        issues.push('`domain` is empty after trimming');
      }
      if (baseDomain !== undefined && !normalizeBaseDomain(baseDomain)) {
        issues.push('`baseDomain` is empty after trimming');
      }
      if (instanceLabel !== undefined && !sanitizeDomainLabel(instanceLabel)) {
        issues.push('`instanceLabel` is empty after sanitization');
      }

      const info = getGitRepoInfo();
      const resolvedRepo = repo ?? info.repo;
      const resolvedBranch = branch ?? info.branch;
      if (!resolvedRepo) {
        issues.push('repo name not found (not a git repo?)');
      }
      if (!resolvedBranch) {
        issues.push('branch name not found (detached HEAD?)');
      }

      if (issues.length === 0) {
        return 'No domain resolved. Provide `domain`, or `repo` and `branch`, or ensure git metadata is available.';
      }

      return `No domain resolved. Issues: ${issues.join('; ')}. Provide \`domain\`, or \`repo\` and \`branch\`, or ensure git metadata is available.`;
    }

    if (domainArray.length === 0) {
      console.error(buildDomainResolutionMessage());
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
      if (previewMode && resolvedPort === null) {
        const previewPort = getPreviewPort(config);
        if (previewPort !== null) {
          resolvedPort = previewPort;
        }
      }

      if (resolvedHost === null) {
        if (previewMode) {
          resolvedHost = getPreviewHost(config);
        }
        if (resolvedHost === null) {
          resolvedHost = resolveUpstreamHost(config.server.host);
        }
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

    function formatUpstreamTarget(host: string, port: number) {
      if (host.includes(':') && !host.startsWith('[')) {
        return `[${host}]:${port}`;
      }
      return `${host}:${port}`;
    }

    async function cleanupRoute() {
      if (cleanupStarted) return;
      cleanupStarted = true;
      if (tlsPolicyId) {
        await removeWithRetry(
          () => removeTlsPolicy(tlsPolicyId, pluginCaddyApiUrl, pluginCaddyAdminOrigin),
          'TLS policy',
        );
      }
      await removeWithRetry(
        () => removeRoute(routeId, pluginCaddyApiUrl, pluginCaddyAdminOrigin),
        'route',
      );
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

    function wait(ms: number) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function removeWithRetry(
      remover: () => Promise<boolean>,
      label: string,
      maxAttempts = 3,
    ) {
      let attempt = 0;
      let delayMs = 100;

      while (attempt < maxAttempts) {
        const ok = await remover();
        if (ok) return true;
        attempt += 1;
        if (attempt < maxAttempts) {
          await wait(delayMs);
          delayMs *= 2;
        }
      }

      console.error(`Failed to remove ${label} after ${maxAttempts} attempts.`);
      return false;
    }

    async function setupRoute() {
      if (!validateCaddyIsInstalled()) {
        return;
      }

      // 1. Ensure Caddy is running and base config exists
      try {
        await ensureCaddyReady(serverName, pluginCaddyApiUrl, pluginCaddyAdminOrigin);
      } catch (e) {
        console.error(
          `Failed to configure Caddy base settings. Is the Caddy Admin API reachable at ${pluginCaddyApiUrl}?`,
          e,
        );
        return;
      }

      const port = getServerPort();
      const upstreamHost = getUpstreamHost();

      // 2. Replace stale config and add the specific route for this app
      await cleanupStaleRoutesForDomains(
        domainArray,
        routeId,
        serverName,
        pluginCaddyApiUrl,
        pluginCaddyAdminOrigin,
      );
      await removeRoute(routeId, pluginCaddyApiUrl, pluginCaddyAdminOrigin);
      if (tlsPolicyId) {
        await removeTlsPolicy(tlsPolicyId, pluginCaddyApiUrl, pluginCaddyAdminOrigin);
        try {
          await addTlsPolicy(
            tlsPolicyId,
            domainArray,
            pluginCaddyApiUrl,
            pluginCaddyAdminOrigin,
          );
          tlsPolicyAdded = true;
        } catch (e) {
          console.error(
            `Failed to add TLS policy to Caddy. Is the Caddy Admin API reachable at ${pluginCaddyApiUrl}?`,
            e,
          );
          return;
        }
      }

      try {
        await addRoute(
          routeId,
          domainArray,
          port,
          cors,
          serverName,
          upstreamHost,
          upstreamHostHeader,
          pluginCaddyApiUrl,
          pluginCaddyAdminOrigin,
        );
      } catch (e) {
        if (tlsPolicyAdded && tlsPolicyId) {
          await removeTlsPolicy(tlsPolicyId, pluginCaddyApiUrl, pluginCaddyAdminOrigin);
        }
        console.error(
          `Failed to add route to Caddy. Is the Caddy Admin API reachable at ${pluginCaddyApiUrl}?`,
          e,
        );
        return;
      }

      console.log('\n🔒 Caddy is proxying your traffic on https');
      console.log(`\n➡️ Upstream target: http://${formatUpstreamTarget(upstreamHost, port)}`);
      console.log(
        `\n🔗 Access your local ${domainArray.length > 1 ? 'servers' : 'server'}!`,
      );

      domainArray.forEach((domain) => {
        console.log(`🌍 https://${domain}`);
      });

      if (process.platform === 'linux' && !loopbackDomain) {
        console.log('\n🐧 Linux users: if the domain doesn\'t resolve, run:');
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
      if (!hasListen(server)) return false;
      const originalListen = server.listen.bind(server);
      server.listen = async function (port?: number, isRestart?: boolean) {
        const result = await originalListen(port, isRestart);
        // Vite can auto-increment when the requested port is busy.
        // Always re-resolve from the bound server address after listen().
        resolvedPort = null;
        updateResolvedTarget();
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
  }

  return {
    name: 'vite:caddy-tls',
    config(userConfig) {
      const resolvedDomains = resolveDomains({
        domain,
        baseDomain,
        loopbackDomain,
        repo,
        branch,
        instanceLabel,
      });
      const defaultHmrDomain = resolvedDomains?.[0];
      const hmrConfig =
        userConfig.server?.hmr === undefined && defaultHmrDomain
          ? {
              protocol: 'wss',
              host: defaultHmrDomain,
              clientPort: 443,
            }
          : userConfig.server?.hmr;

      return {
        server: {
          host: userConfig.server?.host === undefined ? true : userConfig.server.host,
          allowedHosts:
            userConfig.server?.allowedHosts === undefined
              ? true
              : userConfig.server.allowedHosts,
          ...(hmrConfig !== undefined ? { hmr: hmrConfig } : {}),
        },
        preview: {
          host: userConfig.preview?.host === undefined ? true : userConfig.preview.host,
          allowedHosts:
            userConfig.preview?.allowedHosts === undefined
              ? true
              : userConfig.preview.allowedHosts,
        },
      };
    },
    configureServer(server) {
      setupServer(server);
    },
    configurePreviewServer(server) {
      setupServer(server);
    },
  };
}
