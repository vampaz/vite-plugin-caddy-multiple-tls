import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRoute, addTlsPolicy, ensureBaseConfig } from './utils.js';

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

describe('ensureBaseConfig', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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

    expect(proxy?.headers?.request?.set?.Host).toBe('localhost');
  });
});

describe('addTlsPolicy', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
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
