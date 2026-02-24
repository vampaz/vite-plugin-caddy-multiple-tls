import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_SERVER_NAME = 'srv0';
export const DEFAULT_CADDY_API_URL = 'http://localhost:2019';
export const CADDY_ADMIN_ORIGIN_POLICY_ERROR_MESSAGE =
  'Caddy Admin API rejected request due to origin policy. Check caddyApiUrl and admin origin settings.';

const CONNECTIVITY_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

type CaddyAdminStatus =
  | { status: 'running' }
  | { status: 'connectivity-error'; error: Error }
  | { status: 'api-error'; error: Error };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseConfig(text: string): unknown | undefined {
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    return undefined;
  }
}

function isTlsPolicyOverlapError(text: string) {
  return text.includes('cannot apply more than one automation policy to host');
}

function getApiUrl(apiUrl?: string) {
  return apiUrl ?? DEFAULT_CADDY_API_URL;
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isOriginPolicyError(status: number, text: string) {
  if (status !== 403) return false;
  const normalizedText = text.toLowerCase();
  return normalizedText.includes('origin') && normalizedText.includes('not allowed');
}

function buildCaddyRequestError(message: string, status: number, text: string) {
  if (isOriginPolicyError(status, text)) {
    return new Error(CADDY_ADMIN_ORIGIN_POLICY_ERROR_MESSAGE);
  }

  const normalizedText = text.trim();
  if (!normalizedText) {
    return new Error(`${message}: HTTP ${status}`);
  }

  return new Error(`${message}: ${normalizedText}`);
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;

  if ('code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }

  if ('cause' in error) {
    const cause = (error as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object') {
      if ('code' in cause && typeof (cause as { code?: unknown }).code === 'string') {
        return (cause as { code: string }).code;
      }
    }
  }

  return undefined;
}

function isConnectivityError(error: unknown) {
  const code = getErrorCode(error);
  return Boolean(code) && CONNECTIVITY_ERROR_CODES.has(code as string);
}

function getAdminOrigin(apiUrl?: string, adminOrigin?: string) {
  const originSource = adminOrigin ?? getApiUrl(apiUrl);
  try {
    return new URL(originSource).origin;
  } catch (e) {
    return new URL(getApiUrl(apiUrl)).origin;
  }
}

async function caddyFetch(
  input: string,
  init?: RequestInit,
  apiUrl?: string,
  adminOrigin?: string,
) {
  const headers = new Headers(init?.headers);
  headers.set('Origin', getAdminOrigin(apiUrl, adminOrigin));

  return fetch(input, {
    ...init,
    headers,
  });
}

async function checkCaddyAdminStatus(
  apiUrl?: string,
  adminOrigin?: string,
): Promise<CaddyAdminStatus> {
  try {
    const res = await caddyFetch(`${getApiUrl(apiUrl)}/config/`, undefined, apiUrl, adminOrigin);
    if (res.ok) {
      return { status: 'running' };
    }

    const text = await res.text();
    return {
      status: 'api-error',
      error: buildCaddyRequestError('Failed to read Caddy config', res.status, text),
    };
  } catch (e) {
    const error = toError(e);
    if (isConnectivityError(error)) {
      return {
        status: 'connectivity-error',
        error,
      };
    }

    return {
      status: 'api-error',
      error,
    };
  }
}

async function assertCaddyResponse(res: Response, message: string) {
  if (res.ok) return;
  const text = await res.text();
  throw buildCaddyRequestError(message, res.status, text);
}

function getLockPath(apiUrl?: string) {
  const key = createHash('sha1').update(getApiUrl(apiUrl)).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `vite-plugin-caddy-multiple-tls-${key}.lock`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withApiLock(apiUrl: string | undefined, fn: () => Promise<void>) {
  const lockPath = getLockPath(apiUrl);
  const startedAt = Date.now();
  const timeoutMs = 5000;

  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        await fn();
      } finally {
        await handle.close();
        await unlink(lockPath).catch(() => undefined);
      }
      return;
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') {
        throw e;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        // Keep forward progress even if a stale lock remains from a crashed process.
        await fn();
        return;
      }
      await sleep(50);
    }
  }
}

/**
 * Checks if caddy cli is installed
 */
export function validateCaddyIsInstalled() {
  try {
    execSync('caddy version');
    return true;
  } catch (e) {
    console.error('caddy cli is not installed');
    return false;
  }
}

/**
 * Checks if Caddy is running by pinging the admin API
 */
export async function isCaddyRunning(apiUrl?: string, adminOrigin?: string): Promise<boolean> {
  const status = await checkCaddyAdminStatus(apiUrl, adminOrigin);
  return status.status === 'running';
}

/**
 * Starts Caddy in the background
 */
export async function startCaddy(apiUrl?: string, adminOrigin?: string) {
  // console.log("Starting Caddy in the background...");
  try {
    execSync('caddy start', { stdio: 'ignore' });
  } catch (e) {
    // Another process may have started Caddy concurrently.
  }

  // Wait a bit for it to come up
  for (let i = 0; i < 10; i++) {
    const status = await checkCaddyAdminStatus(apiUrl, adminOrigin);
    if (status.status === 'running') return true;
    if (status.status === 'api-error') {
      throw status.error;
    }

    await sleep(500);
  }
  return false;
}

/**
 * Ensures the base HTTP app and server structure exists in Caddy
 */
export async function ensureBaseConfig(
  serverName = DEFAULT_SERVER_NAME,
  apiUrl?: string,
  adminOrigin?: string,
) {
  const resolvedApiUrl = getApiUrl(apiUrl);
  // Check if server exists
  const serverUrl = `${resolvedApiUrl}/config/apps/http/servers/${serverName}`;
  const res = await caddyFetch(serverUrl, undefined, apiUrl, adminOrigin);
  if (res.ok) return;

  if (res.status === 403) {
    const text = await res.text();
    if (isOriginPolicyError(res.status, text)) {
      throw buildCaddyRequestError(
        'Failed to initialize Caddy base configuration',
        res.status,
        text,
      );
    }
  }

  const baseConfig = {
    listen: [':443'],
    routes: [],
  };

  const httpAppConfig = {
    servers: {
      [serverName]: baseConfig,
    },
  };

  const configRes = await caddyFetch(
    `${resolvedApiUrl}/config/`,
    undefined,
    apiUrl,
    adminOrigin,
  );
  await assertCaddyResponse(configRes, 'Failed to read Caddy config');

  const configText = await configRes.text();
  const config = parseConfig(configText);

  if (config === undefined) {
    throw new Error('Failed to parse Caddy config response.');
  }

  const isEmptyConfig =
    configText.trim() === '' ||
    config === null ||
    (isRecord(config) && Object.keys(config).length === 0);

  if (isEmptyConfig) {
    const loadRes = await caddyFetch(
      `${resolvedApiUrl}/load`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apps: {
            http: httpAppConfig,
          },
        }),
      },
      apiUrl,
      adminOrigin,
    );

    if (!loadRes.ok) {
      const text = await loadRes.text();
      throw buildCaddyRequestError(
        'Failed to initialize Caddy base configuration',
        loadRes.status,
        text,
      );
    }
    return;
  }

  const apps = isRecord(config) ? config.apps : undefined;
  const http = isRecord(apps) ? apps.http : undefined;
  const servers = isRecord(http) ? http.servers : undefined;
  let hasApps = isRecord(apps);
  let hasHttp = isRecord(http);
  let hasServers = isRecord(servers);

  if (!hasApps) {
    const createAppsRes = await caddyFetch(
      `${resolvedApiUrl}/config/apps`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      apiUrl,
      adminOrigin,
    );
    if (!createAppsRes.ok && createAppsRes.status !== 409) {
      const text = await createAppsRes.text();
      throw buildCaddyRequestError(
        'Failed to initialize Caddy base configuration',
        createAppsRes.status,
        text,
      );
    }
    hasApps = true;
  }

  if (!hasHttp) {
    const createHttpRes = await caddyFetch(
      `${resolvedApiUrl}/config/apps/http`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: {} }),
      },
      apiUrl,
      adminOrigin,
    );
    if (!createHttpRes.ok && createHttpRes.status !== 409) {
      const text = await createHttpRes.text();
      throw buildCaddyRequestError(
        'Failed to initialize Caddy base configuration',
        createHttpRes.status,
        text,
      );
    }
    hasHttp = true;
    hasServers = true;
  }

  if (!hasServers) {
    const createServersRes = await caddyFetch(
      `${resolvedApiUrl}/config/apps/http/servers`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      },
      apiUrl,
      adminOrigin,
    );
    if (!createServersRes.ok && createServersRes.status !== 409) {
      const text = await createServersRes.text();
      throw buildCaddyRequestError(
        'Failed to initialize Caddy base configuration',
        createServersRes.status,
        text,
      );
    }
  }

  const createServerRes = await caddyFetch(
    serverUrl,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(baseConfig),
    },
    apiUrl,
    adminOrigin,
  );

  if (!createServerRes.ok && createServerRes.status !== 409) {
    const text = await createServerRes.text();
    throw buildCaddyRequestError(
      'Failed to initialize Caddy base configuration',
      createServerRes.status,
      text,
    );
  }
}

async function ensureTlsAutomation(apiUrl?: string, adminOrigin?: string) {
  const resolvedApiUrl = getApiUrl(apiUrl);
  const policiesUrl = `${resolvedApiUrl}/config/apps/tls/automation/policies`;
  const policiesRes = await caddyFetch(policiesUrl, undefined, apiUrl, adminOrigin);
  if (policiesRes.ok) return;

  const policiesText = await policiesRes.text();
  if (
    policiesRes.status !== 404 &&
    !policiesText.includes('invalid traversal path')
  ) {
    throw buildCaddyRequestError(
      'Failed to initialize Caddy TLS automation',
      policiesRes.status,
      policiesText,
    );
  }

  const automationRes = await caddyFetch(
    `${resolvedApiUrl}/config/apps/tls/automation`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ policies: [] }),
    },
    apiUrl,
    adminOrigin,
  );

  if (automationRes.ok || automationRes.status === 409) return;

  const automationText = await automationRes.text();
  if (!automationText.includes('invalid traversal path')) {
    throw buildCaddyRequestError(
      'Failed to initialize Caddy TLS automation',
      automationRes.status,
      automationText,
    );
  }

  const tlsRes = await caddyFetch(
    `${resolvedApiUrl}/config/apps/tls`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ automation: { policies: [] } }),
    },
    apiUrl,
    adminOrigin,
  );

  if (!tlsRes.ok && tlsRes.status !== 409) {
    const text = await tlsRes.text();
    throw buildCaddyRequestError(
      'Failed to initialize Caddy TLS automation',
      tlsRes.status,
      text,
    );
  }
}

/**
 * Adds a route to proxy a specific domain to a local port
 */
function formatDialAddress(host: string, port: number) {
  if (host.includes(':') && !host.startsWith('[')) {
    return `[${host}]:${port}`;
  }
  return `${host}:${port}`;
}

function extractMatchedHosts(route: unknown) {
  if (!isRecord(route)) return [];
  const match = route.match;
  if (!Array.isArray(match)) return [];

  const hosts: string[] = [];
  for (const item of match) {
    if (!isRecord(item) || !Array.isArray(item.host)) continue;
    for (const host of item.host) {
      if (typeof host === 'string') {
        hosts.push(host);
      }
    }
  }

  return hosts;
}

function intersectsDomains(targetDomains: string[], routeDomains: string[]) {
  if (targetDomains.length === 0 || routeDomains.length === 0) return false;
  const targetSet = new Set(targetDomains);
  return routeDomains.some((domain) => targetSet.has(domain));
}

export async function cleanupStaleRoutesForDomains(
  domains: string[],
  currentRouteId: string,
  serverName = DEFAULT_SERVER_NAME,
  apiUrl?: string,
  adminOrigin?: string,
) {
  if (domains.length === 0) return;

  const res = await caddyFetch(
    `${getApiUrl(apiUrl)}/config/apps/http/servers/${serverName}/routes`,
    undefined,
    apiUrl,
    adminOrigin,
  );
  if (!res.ok) return;

  const text = await res.text();
  const parsed = parseConfig(text);
  if (!Array.isArray(parsed)) return;

  for (const route of parsed) {
    if (!isRecord(route)) continue;
    const id = route['@id'];
    if (typeof id !== 'string') continue;
    if (!id.startsWith('vite-proxy-')) continue;
    if (id === currentRouteId) continue;

    const routeDomains = extractMatchedHosts(route);
    if (!intersectsDomains(domains, routeDomains)) continue;

    await removeRoute(id, apiUrl, adminOrigin);
  }
}

export async function addRoute(
  id: string,
  domains: string[],
  port: number,
  cors?: string,
  serverName = DEFAULT_SERVER_NAME,
  upstreamHost = '127.0.0.1',
  upstreamHostHeader?: string,
  apiUrl?: string,
  adminOrigin?: string,
) {
  const handlers: Array<Record<string, unknown>> = [];
  if (cors) {
    handlers.push({
      handler: 'headers',
      response: {
        set: {
          'Access-Control-Allow-Origin': [cors],
          'Access-Control-Allow-Methods': [
            'GET',
            'POST',
            'PUT',
            'PATCH',
            'DELETE',
            'OPTIONS',
          ],
          'Access-Control-Allow-Headers': ['*'],
        },
      },
    });
  }
  const reverseProxyHandler: Record<string, unknown> = {
    handler: 'reverse_proxy',
    upstreams: [{ dial: formatDialAddress(upstreamHost, port) }],
  };

  if (upstreamHostHeader) {
    reverseProxyHandler.headers = {
      request: {
        set: {
          Host: [upstreamHostHeader],
        },
      },
    };
  }

  handlers.push(reverseProxyHandler);

  const route = {
    '@id': id,
    match: [{ host: domains }],
    handle: [
      {
        handler: 'subroute',
        routes: [
          {
            handle: handlers,
          },
        ],
      },
    ],
    terminal: true,
  };

  const res = await caddyFetch(
    `${getApiUrl(apiUrl)}/config/apps/http/servers/${serverName}/routes`,
    {
      method: 'POST', // Append to routes list
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route),
    },
    apiUrl,
    adminOrigin,
  );

  if (!res.ok) {
    const text = await res.text();
    throw buildCaddyRequestError('Failed to add route', res.status, text);
  }
}

/**
 * Adds a TLS automation policy using the internal issuer for the given domains
 */
export async function addTlsPolicy(
  id: string,
  domains: string[],
  apiUrl?: string,
  adminOrigin?: string,
) {
  await ensureTlsAutomation(apiUrl, adminOrigin);
  const policy = {
    '@id': id,
    subjects: domains,
    issuers: [
      {
        module: 'internal',
      },
    ],
  };

  const res = await caddyFetch(
    `${getApiUrl(apiUrl)}/config/apps/tls/automation/policies`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(policy),
    },
    apiUrl,
    adminOrigin,
  );

  if (!res.ok) {
    const text = await res.text();
    if (isTlsPolicyOverlapError(text)) {
      return;
    }
    throw buildCaddyRequestError('Failed to add TLS policy', res.status, text);
  }
}

/**
 * Removes a route by its ID
 */
export async function removeRoute(id: string, apiUrl?: string, adminOrigin?: string) {
  const res = await caddyFetch(
    `${getApiUrl(apiUrl)}/id/${id}`,
    {
      method: 'DELETE',
    },
    apiUrl,
    adminOrigin,
  );

  // 404 is fine (already gone)
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    const error = buildCaddyRequestError(`Failed to remove route ${id}`, res.status, text);
    console.error(error.message);
    return false;
  }
  return true;
}

/**
 * Removes a TLS automation policy by its ID
 */
export async function removeTlsPolicy(id: string, apiUrl?: string, adminOrigin?: string) {
  const res = await caddyFetch(
    `${getApiUrl(apiUrl)}/id/${id}`,
    {
      method: 'DELETE',
    },
    apiUrl,
    adminOrigin,
  );

  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    const error = buildCaddyRequestError(
      `Failed to remove TLS policy ${id}`,
      res.status,
      text,
    );
    console.error(error.message);
    return false;
  }
  return true;
}

export async function ensureCaddyReady(
  serverName = DEFAULT_SERVER_NAME,
  apiUrl?: string,
  adminOrigin?: string,
) {
  await withApiLock(apiUrl, async () => {
    const status = await checkCaddyAdminStatus(apiUrl, adminOrigin);

    if (status.status === 'api-error') {
      throw status.error;
    }

    let running = status.status === 'running';
    if (status.status === 'connectivity-error') {
      running = await startCaddy(apiUrl, adminOrigin);
    }

    if (!running) {
      throw new Error('Failed to start Caddy server.');
    }

    await ensureBaseConfig(serverName, apiUrl, adminOrigin);
  });
}
