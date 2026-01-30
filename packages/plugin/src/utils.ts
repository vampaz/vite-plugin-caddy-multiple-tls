import { execSync } from 'node:child_process';

const DEFAULT_SERVER_NAME = 'srv0';
let caddyApiUrl = 'http://localhost:2019';

export function setCaddyApiUrl(url: string) {
  caddyApiUrl = url;
}

export function getCaddyApiUrl() {
  return caddyApiUrl;
}

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
export async function isCaddyRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${caddyApiUrl}/config/`);
    return res.ok;
  } catch (e) {
    return false;
  }
}

/**
 * Starts Caddy in the background
 */
export async function startCaddy() {
  // console.log("Starting Caddy in the background...");
  try {
    execSync('caddy start', { stdio: 'ignore' });
    // Wait a bit for it to come up
    for (let i = 0; i < 10; i++) {
      if (await isCaddyRunning()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  } catch (e) {
    console.error('Failed to start Caddy:', e);
    return false;
  }
}

/**
 * Ensures the base HTTP app and server structure exists in Caddy
 */
export async function ensureBaseConfig(serverName = DEFAULT_SERVER_NAME) {
  // Check if server exists
  const serverUrl = `${caddyApiUrl}/config/apps/http/servers/${serverName}`;
  const res = await fetch(serverUrl);
  if (res.ok) return;

  const baseConfig = {
    listen: [':443'],
    routes: [],
  };

  const httpAppConfig = {
    servers: {
      [serverName]: baseConfig,
    },
  };

  const configRes = await fetch(`${caddyApiUrl}/config/`);
  if (!configRes.ok) {
    const text = await configRes.text();
    throw new Error(`Failed to read Caddy config: ${text}`);
  }

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
    const loadRes = await fetch(`${caddyApiUrl}/load`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apps: {
          http: httpAppConfig,
        },
      }),
    });

    if (!loadRes.ok) {
      const text = await loadRes.text();
      throw new Error(`Failed to initialize Caddy base configuration: ${text}`);
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
    const createAppsRes = await fetch(`${caddyApiUrl}/config/apps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!createAppsRes.ok && createAppsRes.status !== 409) {
      const text = await createAppsRes.text();
      throw new Error(`Failed to initialize Caddy base configuration: ${text}`);
    }
    hasApps = true;
  }

  if (!hasHttp) {
    const createHttpRes = await fetch(`${caddyApiUrl}/config/apps/http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ servers: {} }),
    });
    if (!createHttpRes.ok && createHttpRes.status !== 409) {
      const text = await createHttpRes.text();
      throw new Error(`Failed to initialize Caddy base configuration: ${text}`);
    }
    hasHttp = true;
    hasServers = true;
  }

  if (!hasServers) {
    const createServersRes = await fetch(`${caddyApiUrl}/config/apps/http/servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!createServersRes.ok && createServersRes.status !== 409) {
      const text = await createServersRes.text();
      throw new Error(`Failed to initialize Caddy base configuration: ${text}`);
    }
  }

  const createServerRes = await fetch(serverUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(baseConfig),
  });

  if (!createServerRes.ok && createServerRes.status !== 409) {
    const text = await createServerRes.text();
    throw new Error(`Failed to initialize Caddy base configuration: ${text}`);
  }
}

async function ensureTlsAutomation() {
  const policiesUrl = `${caddyApiUrl}/config/apps/tls/automation/policies`;
  const policiesRes = await fetch(policiesUrl);
  if (policiesRes.ok) return;

  const policiesText = await policiesRes.text();
  if (
    policiesRes.status !== 404 &&
    !policiesText.includes('invalid traversal path')
  ) {
    throw new Error(
      `Failed to initialize Caddy TLS automation: ${policiesText}`,
    );
  }

  const automationRes = await fetch(`${caddyApiUrl}/config/apps/tls/automation`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ policies: [] }),
  });

  if (automationRes.ok || automationRes.status === 409) return;

  const automationText = await automationRes.text();
  if (!automationText.includes('invalid traversal path')) {
    throw new Error(
      `Failed to initialize Caddy TLS automation: ${automationText}`,
    );
  }

  const tlsRes = await fetch(`${caddyApiUrl}/config/apps/tls`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ automation: { policies: [] } }),
  });

  if (!tlsRes.ok && tlsRes.status !== 409) {
    const text = await tlsRes.text();
    throw new Error(`Failed to initialize Caddy TLS automation: ${text}`);
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

export async function addRoute(
  id: string,
  domains: string[],
  port: number,
  cors?: string,
  serverName = DEFAULT_SERVER_NAME,
  upstreamHost = '127.0.0.1',
  upstreamHostHeader?: string,
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

  const res = await fetch(
    `${caddyApiUrl}/config/apps/http/servers/${serverName}/routes`,
    {
      method: 'POST', // Append to routes list
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(route),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add route: ${text}`);
  }
}

/**
 * Adds a TLS automation policy using the internal issuer for the given domains
 */
export async function addTlsPolicy(id: string, domains: string[]) {
  await ensureTlsAutomation();
  const policy = {
    '@id': id,
    subjects: domains,
    issuers: [
      {
        module: 'internal',
      },
    ],
  };

  const res = await fetch(`${caddyApiUrl}/config/apps/tls/automation/policies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(policy),
  });

  if (!res.ok) {
    const text = await res.text();
    if (isTlsPolicyOverlapError(text)) {
      return;
    }
    throw new Error(`Failed to add TLS policy: ${text}`);
  }
}

/**
 * Removes a route by its ID
 */
export async function removeRoute(id: string) {
  const res = await fetch(`${caddyApiUrl}/id/${id}`, {
    method: 'DELETE',
  });

  // 404 is fine (already gone)
  if (!res.ok && res.status !== 404) {
    console.error(`Failed to remove route ${id}`);
    return false;
  }
  return true;
}

/**
 * Removes a TLS automation policy by its ID
 */
export async function removeTlsPolicy(id: string) {
  const res = await fetch(`${caddyApiUrl}/id/${id}`, {
    method: 'DELETE',
  });

  if (!res.ok && res.status !== 404) {
    console.error(`Failed to remove TLS policy ${id}`);
    return false;
  }
  return true;
}
