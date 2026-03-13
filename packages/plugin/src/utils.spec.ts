import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addRoute,
  addTlsPolicy,
  CADDY_ADMIN_ORIGIN_POLICY_ERROR_MESSAGE,
  claimRouteOwnership,
  ensureBaseConfig,
  ensureCaddyReady,
  findManagedRoutesForDomains,
  findManagedTlsPoliciesForDomains,
  getRouteOwnershipBaseDirectory,
  isCaddyRunning,
  readRouteOwnership,
  releaseRouteOwnership,
  touchRouteOwnership,
} from './utils.js';

const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

type FetchResponse = {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
};

function createResponse(options: {
  ok: boolean;
  status?: number;
  text?: string;
}): FetchResponse {
  return {
    ok: options.ok,
    status: options.status ?? (options.ok ? 200 : 500),
    text: async () => options.text ?? '',
  };
}

function getHeader(options: RequestInit | undefined, name: string) {
  return new Headers(options?.headers).get(name);
}

async function resetRouteOwnershipDirectory() {
  await rm(getRouteOwnershipBaseDirectory(), { recursive: true, force: true });
}

function createOwnershipRecord(overrides: Record<string, unknown> = {}) {
  const now = Date.now();

  return {
    version: 1 as const,
    ownerId: 'owner-1',
    pid: process.pid,
    cwd: process.cwd(),
    configRoot: '/tmp/app',
    domains: ['app.localhost'],
    routeId: 'vite-proxy-owner-1',
    tlsPolicyId: null,
    serverName: 'srv0',
    caddyApiUrl: 'http://localhost:2019',
    startedAt: now,
    lastSeenAt: now,
    ...overrides,
  };
}

function createNodeError(code: string) {
  const error = new Error(code) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

type OriginGuardServer = {
  apiUrl: string;
  expectedOrigin: string;
  close: () => Promise<void>;
};

function closeServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function listenServer(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

async function startOriginGuardServer(
  resolveExpectedOrigin: (port: number) => string,
): Promise<OriginGuardServer> {
  let expectedOrigin = '';
  const server = createServer((request, response) => {
    if (request.url !== '/config/') {
      response.statusCode = 404;
      response.end();
      return;
    }

    const origin = request.headers.origin ?? '';
    if (origin !== expectedOrigin) {
      response.statusCode = 403;
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          error: `client is not allowed to access from origin '${origin}'`,
        }),
      );
      return;
    }

    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.end('{}');
  });

  await listenServer(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start origin guard server');
  }

  const apiUrl = `http://127.0.0.1:${address.port}`;
  expectedOrigin = resolveExpectedOrigin(address.port);

  return {
    apiUrl,
    expectedOrigin,
    close: () => closeServer(server),
  };
}

beforeEach(async () => {
  await resetRouteOwnershipDirectory();
});

afterEach(async () => {
  await resetRouteOwnershipDirectory();
});

describe('route ownership', () => {
  it('claims ownership when no record exists', async () => {
    const record = createOwnershipRecord();

    await expect(claimRouteOwnership(record)).resolves.toEqual({
      status: 'claimed',
      currentRecord: record,
    });
    await expect(
      readRouteOwnership({
        domains: record.domains,
        serverName: record.serverName,
        caddyApiUrl: record.caddyApiUrl,
      }),
    ).resolves.toEqual(record);
  });

  it('refuses a live conflicting owner', async () => {
    const firstRecord = createOwnershipRecord();
    const secondRecord = createOwnershipRecord({
      ownerId: 'owner-2',
      routeId: 'vite-proxy-owner-2',
    });

    await claimRouteOwnership(firstRecord);

    await expect(claimRouteOwnership(secondRecord)).resolves.toEqual({
      status: 'active-conflict',
      currentRecord: secondRecord,
      existingRecord: firstRecord,
    });
  });

  it('keeps a live pid active even when the heartbeat is stale', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0 && pid === 42_424) {
        return true;
      }

      throw createNodeError('ESRCH');
    });
    const firstRecord = createOwnershipRecord({
      pid: 42_424,
      lastSeenAt: Date.now() - 60_000,
    });
    const secondRecord = createOwnershipRecord({
      ownerId: 'owner-2',
      routeId: 'vite-proxy-owner-2',
    });

    await claimRouteOwnership(firstRecord);

    await expect(claimRouteOwnership(secondRecord)).resolves.toEqual({
      status: 'active-conflict',
      currentRecord: secondRecord,
      existingRecord: firstRecord,
    });

    killSpy.mockRestore();
  });

  it('reclaims a stale owner record', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw createNodeError('ESRCH');
    });
    const staleRecord = createOwnershipRecord({
      ownerId: 'owner-stale',
      pid: 99_999,
      routeId: 'vite-proxy-owner-stale',
      lastSeenAt: Date.now() - 60_000,
    });
    const nextRecord = createOwnershipRecord({
      ownerId: 'owner-next',
      routeId: 'vite-proxy-owner-next',
    });

    await claimRouteOwnership(staleRecord);

    await expect(claimRouteOwnership(nextRecord)).resolves.toEqual({
      status: 'reclaimed',
      currentRecord: nextRecord,
      previousRecord: staleRecord,
    });

    killSpy.mockRestore();
  });

  it('touches and releases ownership only for the active owner', async () => {
    const record = createOwnershipRecord();

    await claimRouteOwnership(record);
    await expect(releaseRouteOwnership({ ...record, ownerId: 'other-owner' })).resolves.toBe(
      false,
    );
    await expect(touchRouteOwnership(record)).resolves.toBe(true);
    const storedRecord = await readRouteOwnership({
      domains: record.domains,
      serverName: record.serverName,
      caddyApiUrl: record.caddyApiUrl,
    });
    expect(storedRecord?.lastSeenAt).toBeGreaterThanOrEqual(record.lastSeenAt);
    await expect(releaseRouteOwnership(record)).resolves.toBe(true);
    await expect(
      readRouteOwnership({
        domains: record.domains,
        serverName: record.serverName,
        caddyApiUrl: record.caddyApiUrl,
      }),
    ).resolves.toBeNull();
  });
});

describe('findManagedRoutesForDomains', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns matching managed route ids without deleting them', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        ok: true,
        text: JSON.stringify([
          {
            '@id': 'vite-proxy-owner-1',
            match: [{ host: ['app.localhost'] }],
          },
          {
            '@id': 'vite-proxy-owner-2',
            match: [{ host: ['other.localhost'] }],
          },
          {
            '@id': 'custom-route',
            match: [{ host: ['app.localhost'] }],
          },
        ]),
      }),
    );

    await expect(findManagedRoutesForDomains(['app.localhost'])).resolves.toEqual([
      'vite-proxy-owner-1',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('findManagedTlsPoliciesForDomains', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns matching managed tls policy ids without deleting them', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        ok: true,
        text: JSON.stringify([
          {
            '@id': 'vite-proxy-owner-1-tls',
            subjects: ['app.localhost'],
          },
          {
            '@id': 'vite-proxy-owner-2-tls',
            subjects: ['other.localhost'],
          },
          {
            '@id': 'custom-policy',
            subjects: ['app.localhost'],
          },
        ]),
      }),
    );

    await expect(findManagedTlsPoliciesForDomains(['app.localhost'])).resolves.toEqual([
      'vite-proxy-owner-1-tls',
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('isCaddyRunning', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('injects Origin from caddyApiUrl', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    const running = await isCaddyRunning('http://127.0.0.1:2019');

    expect(running).toBe(true);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(getHeader(options, 'Origin')).toBe('http://127.0.0.1:2019');
  });

  it('uses explicit caddyAdminOrigin when provided', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    const running = await isCaddyRunning(
      'http://127.0.0.1:2019',
      'http://caddy-admin.local:2019',
    );

    expect(running).toBe(true);
    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(getHeader(options, 'Origin')).toBe('http://caddy-admin.local:2019');
  });

  it('returns false when Admin API rejects origin', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        ok: false,
        status: 403,
        text: `{"error":"client is not allowed to access from origin ''"}`,
      }),
    );

    const running = await isCaddyRunning();

    expect(running).toBe(false);
  });
});

describe('ensureCaddyReady', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('surfaces origin policy errors without trying to start Caddy', async () => {
    fetchMock.mockResolvedValue(
      createResponse({
        ok: false,
        status: 403,
        text: `{"error":"client is not allowed to access from origin ''"}`,
      }),
    );

    await expect(ensureCaddyReady('srv0')).rejects.toThrow(
      CADDY_ADMIN_ORIGIN_POLICY_ERROR_MESSAGE,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tries to start Caddy only after connectivity failures', async () => {
    const connectivityError = new TypeError('fetch failed');
    (connectivityError as TypeError & { cause?: { code: string } }).cause = {
      code: 'ECONNREFUSED',
    };

    fetchMock
      .mockRejectedValueOnce(connectivityError)
      .mockResolvedValueOnce(createResponse({ ok: true }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await expect(ensureCaddyReady('srv0')).resolves.toBeUndefined();
    expect(execSyncMock).toHaveBeenCalledWith('caddy start', { stdio: 'ignore' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe('origin enforcement integration', () => {
  let guardServer: OriginGuardServer | null;

  beforeEach(() => {
    execSyncMock.mockReset();
    guardServer = null;
  });

  afterEach(async () => {
    if (!guardServer) return;
    await guardServer.close();
    guardServer = null;
  });

  it('transitions from denied to allowed when helper injects expected Origin', async () => {
    guardServer = await startOriginGuardServer((port) => {
      return `http://localhost:${port}`;
    });

    const deniedResponse = await fetch(`${guardServer.apiUrl}/config/`);
    expect(deniedResponse.status).toBe(403);

    const withoutOverride = await isCaddyRunning(guardServer.apiUrl);
    expect(withoutOverride).toBe(false);

    const withOverride = await isCaddyRunning(
      guardServer.apiUrl,
      guardServer.expectedOrigin,
    );
    expect(withOverride).toBe(true);
  });
});

describe('ensureBaseConfig', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('skips creation when the server already exists', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    await ensureBaseConfig('srv0');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:2019/config/apps/http/servers/srv0',
    );
  });

  it('loads base config when no config is present', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: false, status: 404 }))
      .mockResolvedValueOnce(createResponse({ ok: true, text: '' }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await expect(ensureBaseConfig('srv0')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:2019/load');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'POST' });
  });

  it('treats null config as empty and loads base config', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: false, status: 404 }))
      .mockResolvedValueOnce(createResponse({ ok: true, text: 'null' }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await expect(ensureBaseConfig('srv0')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe('http://localhost:2019/load');
  });

  it('creates the http app when apps are present but http is missing', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: false, status: 404 }))
      .mockResolvedValueOnce(
        createResponse({
          ok: true,
          text: '{"apps":{}}',
        }),
      )
      .mockResolvedValueOnce(createResponse({ ok: true }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await expect(ensureBaseConfig('srv0')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://localhost:2019/config/apps/http',
    );
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'PUT' });
    expect(fetchMock.mock.calls[3][0]).toBe(
      'http://localhost:2019/config/apps/http/servers/srv0',
    );
  });

  it('tolerates concurrent base config creation', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: false, status: 404 }))
      .mockResolvedValueOnce(
        createResponse({
          ok: true,
          text: '{"apps":{"http":{"servers":{}}}}',
        }),
      )
      .mockResolvedValueOnce(createResponse({ ok: false, status: 409 }));

    await expect(ensureBaseConfig('srv0')).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toBe(
      'http://localhost:2019/config/apps/http/servers/srv0',
    );
  });
});

describe('addRoute', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds CORS headers and targets the provided server name', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    await addRoute(
      'route-1',
      ['app.localhost'],
      4321,
      'https://example.test',
      'custom',
      '127.0.0.1',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'http://localhost:2019/config/apps/http/servers/custom/routes',
    );

    const body = JSON.parse((options as RequestInit).body as string);
    const handlers = body.handle[0].routes[0].handle;
    expect(handlers[0].handler).toBe('headers');
    expect(handlers[0].response.set['Access-Control-Allow-Origin']).toEqual([
      'https://example.test',
    ]);
  });

  it('uses the upstream host when provided', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    await addRoute('route-1', ['app.localhost'], 4321, undefined, 'srv0', 'localhost');

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const handlers = body.handle[0].routes[0].handle;
    const proxy = handlers.find((handler: { handler?: string }) => {
      return handler.handler === 'reverse_proxy';
    }) as { upstreams?: Array<{ dial: string }> } | undefined;

    expect(proxy?.upstreams?.[0]?.dial).toBe('localhost:4321');
  });

  it('overrides the upstream Host header when provided', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    await addRoute(
      'route-1',
      ['app.localhost'],
      4321,
      undefined,
      'srv0',
      'localhost',
      'localhost',
    );

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    const handlers = body.handle[0].routes[0].handle;
    const proxy = handlers.find((handler: { handler?: string }) => {
      return handler.handler === 'reverse_proxy';
    }) as { headers?: { request?: { set?: Record<string, string> } } } | undefined;

    expect(proxy?.headers?.request?.set?.Host).toEqual(['localhost']);
  });

  it('preserves existing headers while injecting Origin', async () => {
    fetchMock.mockResolvedValue(createResponse({ ok: true }));

    await addRoute(
      'route-1',
      ['app.localhost'],
      4321,
      undefined,
      'srv0',
      '127.0.0.1',
      undefined,
      'http://127.0.0.1:2020',
    );

    const options = fetchMock.mock.calls[0][1] as RequestInit;
    expect(getHeader(options, 'Content-Type')).toBe('application/json');
    expect(getHeader(options, 'Origin')).toBe('http://127.0.0.1:2020');
  });
});

describe('addTlsPolicy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    execSyncMock.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('adds an internal TLS policy for the provided domains', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: true }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await addTlsPolicy('tls-1', ['local.conekto.eu']);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:2019/config/apps/tls/automation/policies',
    );
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.issuers[0].module).toBe('internal');
  });

  it('ignores overlapping TLS policy errors', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: true }))
      .mockResolvedValueOnce(
        createResponse({
          ok: false,
          status: 400,
          text:
            '{"error":"loading new config: loading tls app module: tls: invalid configuration: automation policy 2: cannot apply more than one automation policy to host: app.localhost (first match in policy 1)"}',
        }),
      );

    await expect(addTlsPolicy('tls-3', ['app.localhost'])).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('initializes TLS automation when missing', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse({ ok: false, status: 404 }))
      .mockResolvedValueOnce(createResponse({ ok: true }))
      .mockResolvedValueOnce(createResponse({ ok: true }));

    await addTlsPolicy('tls-2', ['local.notesauditor.ai']);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'http://localhost:2019/config/apps/tls/automation',
    );
  });
});
