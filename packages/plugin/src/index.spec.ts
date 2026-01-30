import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import viteCaddyTlsPlugin from './index.js';
import { addRoute, addTlsPolicy, removeRoute, removeTlsPolicy } from './utils.js';

function execSyncMock(command: string) {
  if (command.includes('--show-toplevel')) return '/tmp/my-repo';
  if (command.includes('--abbrev-ref')) return 'feature/test';
  if (command.includes('--short')) return 'abc123';
  return '';
}

const execSyncMockFn = vi.hoisted(() => vi.fn(execSyncMock));

vi.mock('node:child_process', () => ({
  execSync: execSyncMockFn,
}));

vi.mock('./utils.js', () => ({
  validateCaddyIsInstalled: vi.fn(() => true),
  isCaddyRunning: vi.fn(() => Promise.resolve(true)),
  startCaddy: vi.fn(() => Promise.resolve(true)),
  ensureBaseConfig: vi.fn(() => Promise.resolve()),
  addRoute: vi.fn(() => Promise.resolve()),
  addTlsPolicy: vi.fn(() => Promise.resolve()),
  removeRoute: vi.fn(() => Promise.resolve(true)),
  removeTlsPolicy: vi.fn(() => Promise.resolve(true)),
}));

type Listener = (...args: unknown[]) => void;

function createHttpServer(port: number) {
  const server = new EventEmitter() as EventEmitter & {
    listening: boolean;
    address: () => { port: number } | null;
  };

  server.listening = false;
  server.address = function () {
    if (!server.listening) return null;
    return { port };
  };

  return server;
}

function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('viteCaddyTlsPlugin', () => {
  let originalSigintListeners: Listener[];
  let originalSigtermListeners: Listener[];

  beforeEach(() => {
    vi.clearAllMocks();
    originalSigintListeners = process.listeners('SIGINT') as Listener[];
    originalSigtermListeners = process.listeners('SIGTERM') as Listener[];
  });

  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    originalSigintListeners.forEach((listener) => {
      process.on('SIGINT', listener);
    });
    originalSigtermListeners.forEach((listener) => {
      process.on('SIGTERM', listener);
    });
    vi.restoreAllMocks();
  });

  it('uses the bound port after the server starts listening', async () => {
    const httpServer = createHttpServer(4321);
    const plugin = viteCaddyTlsPlugin({
      domain: 'app.localhost',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    expect(addRoute).not.toHaveBeenCalled();

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const call = vi.mocked(addRoute).mock.calls[0];
    expect(call[2]).toBe(4321);
  });

  it('cleans up the route on SIGTERM', async () => {
    const httpServer = createHttpServer(5001);
    const plugin = viteCaddyTlsPlugin({
      baseDomain: 'localhost',
      repo: 'cleanup',
      branch: 'main',
      internalTls: true,
    }) as any;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true);

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const routeId = vi.mocked(addRoute).mock.calls[0][0];
    const tlsPolicyId = vi.mocked(addTlsPolicy).mock.calls[0][0];
    process.emit('SIGTERM');
    await flushPromises();

    expect(removeRoute).toHaveBeenCalledWith(routeId);
    expect(removeTlsPolicy).toHaveBeenCalledWith(tlsPolicyId);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('retries cleanup when route removal fails', async () => {
    const httpServer = createHttpServer(5002);
    const plugin = viteCaddyTlsPlugin({
      domain: 'retry.localhost',
    }) as any;
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true);
    const removeRouteMock = vi.mocked(removeRoute);
    removeRouteMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    process.emit('SIGTERM');
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flushPromises();

    expect(removeRouteMock).toHaveBeenCalledTimes(3);
    expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });

  it('adds a TLS policy when baseDomain is provided', async () => {
    const httpServer = createHttpServer(4322);
    const plugin = viteCaddyTlsPlugin({
      baseDomain: 'local.conekto.eu',
      repo: 'secure',
      branch: 'main',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addTlsPolicy).toHaveBeenCalledTimes(1);
    expect(vi.mocked(addTlsPolicy).mock.calls[0][1]).toEqual([
      'secure.main.local.conekto.eu',
    ]);
  });

  it('uses an explicit domain when provided', async () => {
    const httpServer = createHttpServer(4010);
    const plugin = viteCaddyTlsPlugin({
      domain: 'explicit.localhost',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['explicit.localhost']);
  });

  it('normalizes explicit domains', async () => {
    const httpServer = createHttpServer(4011);
    const plugin = viteCaddyTlsPlugin({
      domain: '  APP.Localhost  ',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['app.localhost']);
  });

  it('supports multiple explicit domains', async () => {
    const httpServer = createHttpServer(4012);
    const plugin = viteCaddyTlsPlugin({
      domain: ['One.Localhost', 'two.localhost', ''],
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['one.localhost', 'two.localhost']);
  });

  it('defaults baseDomain to localhost', async () => {
    const httpServer = createHttpServer(4000);
    const plugin = viteCaddyTlsPlugin() as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['my-repo.feature-test.localhost']);
  });

  it('normalizes baseDomain input', async () => {
    const httpServer = createHttpServer(4004);
    const plugin = viteCaddyTlsPlugin({
      baseDomain: '.LocalHost.',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['my-repo.feature-test.localhost']);
  });

  it('supports loopback domains', async () => {
    const httpServer = createHttpServer(4002);
    const plugin = viteCaddyTlsPlugin({
      loopbackDomain: 'localtest.me',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['my-repo.feature-test.localtest.me']);
  });

  it('maps nip.io to a loopback base domain', async () => {
    const httpServer = createHttpServer(4003);
    const plugin = viteCaddyTlsPlugin({
      loopbackDomain: 'nip.io',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const domains = vi.mocked(addRoute).mock.calls[0][1];
    expect(domains).toEqual(['my-repo.feature-test.127.0.0.1.nip.io']);
  });

  it('supports preview server', async () => {
    const httpServer = createHttpServer(4173);
    const plugin = viteCaddyTlsPlugin({
      domain: 'preview.localhost',
    }) as any;

    plugin.configurePreviewServer({
      httpServer,
      config: { preview: { port: 4173 }, server: {} },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    expect(addRoute).toHaveBeenCalledTimes(1);
    const call = vi.mocked(addRoute).mock.calls[0];
    expect(call[1]).toEqual(['preview.localhost']);
    expect(call[2]).toBe(4173);
  });

  it('prefers resolved URLs when available', async () => {
    const httpServer = createHttpServer(5173);
    const plugin = viteCaddyTlsPlugin({
      domain: 'resolved.localhost',
    }) as any;

    plugin.configureServer({
      httpServer,
      resolvedUrls: { local: ['http://dev.example.test:3999'] },
      config: { server: { port: 5173 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const call = vi.mocked(addRoute).mock.calls[0];
    expect(call[2]).toBe(3999);
    expect(call[5]).toBe('dev.example.test');
  });

  it('resolves wildcard hosts to loopback for upstream', async () => {
    const httpServer = createHttpServer(4005);
    const plugin = viteCaddyTlsPlugin({
      domain: 'wildcard.localhost',
    }) as any;

    plugin.configureServer({
      httpServer,
      config: { server: { host: '0.0.0.0', port: 4005 } },
    });

    httpServer.listening = true;
    httpServer.emit('listening');
    await flushPromises();
    await flushPromises();

    const call = vi.mocked(addRoute).mock.calls[0];
    expect(call[5]).toBe('127.0.0.1');
  });

  it('defaults host and allowedHosts when undefined', () => {
    const plugin = viteCaddyTlsPlugin() as any;

    const config = plugin.config?.({});

    expect(config).toEqual({
      server: {
        host: true,
        allowedHosts: true,
      },
      preview: {
        host: true,
        allowedHosts: true,
      },
    });
  });

  it('preserves user-provided host settings', () => {
    const plugin = viteCaddyTlsPlugin() as any;

    const config = plugin.config?.({
      server: { host: '127.0.0.1', allowedHosts: false },
      preview: { host: '0.0.0.0', allowedHosts: ['example.test'] },
    });

    expect(config).toEqual({
      server: {
        host: '127.0.0.1',
        allowedHosts: false,
      },
      preview: {
        host: '0.0.0.0',
        allowedHosts: ['example.test'],
      },
    });
  });
});
