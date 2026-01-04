import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import viteCaddyTlsPlugin from './index.js';
import { addRoute, addTlsPolicy, removeRoute, removeTlsPolicy } from './utils.js';

const execSyncMock = vi.fn((command: string) => {
  if (command.includes('--show-toplevel')) return '/tmp/my-repo';
  if (command.includes('--abbrev-ref')) return 'feature/test';
  if (command.includes('--short')) return 'abc123';
  return '';
});

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
}));

vi.mock('./utils.js', () => ({
  validateCaddyIsInstalled: vi.fn(() => true),
  isCaddyRunning: vi.fn(() => Promise.resolve(true)),
  startCaddy: vi.fn(() => Promise.resolve(true)),
  ensureBaseConfig: vi.fn(() => Promise.resolve()),
  addRoute: vi.fn(() => Promise.resolve()),
  addTlsPolicy: vi.fn(() => Promise.resolve()),
  removeRoute: vi.fn(() => Promise.resolve()),
  removeTlsPolicy: vi.fn(() => Promise.resolve()),
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
      baseDomain: 'localhost',
      repo: 'app',
      branch: 'main',
    });

    (plugin.configureServer as (ctx: any) => void)({
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
    });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(() => true);

    (plugin.configureServer as (ctx: any) => void)({
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

  it('adds a TLS policy when baseDomain is provided', async () => {
    const httpServer = createHttpServer(4322);
    const plugin = viteCaddyTlsPlugin({
      baseDomain: 'local.conekto.eu',
      repo: 'secure',
      branch: 'main',
    });

    (plugin.configureServer as (ctx: any) => void)({
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

  it('defaults baseDomain to localhost', async () => {
    const httpServer = createHttpServer(4000);
    const plugin = viteCaddyTlsPlugin();

    (plugin.configureServer as (ctx: any) => void)({
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
});
