import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

function resolveRepoRoot() {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
}

function startServer(envOverrides: Record<string, string> = {}) {
  const child = spawn("npm", ["run", "dev", "--workspace", "playground"], {
    cwd: resolveRepoRoot(),
    env: {
      ...process.env,
      FORCE_COLOR: "0",
      ...envOverrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";

  child.stdout.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  return {
    child,
    getOutput() {
      return output;
    },
  };
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractUpstreamTarget(output: string) {
  const match = output.match(/Upstream target: http:\/\/([^\s]+)/);
  return match?.[1] ?? null;
}

function getRouteHosts(route: unknown) {
  if (!route || typeof route !== "object" || !("match" in route)) return [];
  const match = (route as { match?: unknown }).match;
  if (!Array.isArray(match)) return [];

  return match.flatMap((matcher) => {
    if (!matcher || typeof matcher !== "object" || !("host" in matcher)) return [];
    const hosts = (matcher as { host?: unknown }).host;
    if (!Array.isArray(hosts)) return [];
    return hosts.filter((host): host is string => typeof host === "string");
  });
}

function getRouteDial(route: unknown) {
  if (!route || typeof route !== "object" || !("handle" in route)) return null;
  const handle = (route as { handle?: unknown }).handle;
  if (!Array.isArray(handle)) return null;
  const subroute = handle[0];
  if (!subroute || typeof subroute !== "object" || !("routes" in subroute)) return null;
  const routes = (subroute as { routes?: unknown }).routes;
  if (!Array.isArray(routes)) return null;
  const handlers = (routes[0] as { handle?: unknown } | undefined)?.handle;
  if (!Array.isArray(handlers)) return null;
  const proxy = handlers.find((handler) => {
    return Boolean(
      handler &&
      typeof handler === "object" &&
      (handler as { handler?: unknown }).handler === "reverse_proxy",
    );
  });
  if (!proxy || typeof proxy !== "object" || !("upstreams" in proxy)) return null;
  const upstreams = (proxy as { upstreams?: unknown }).upstreams;
  if (!Array.isArray(upstreams)) return null;
  const dial = (upstreams[0] as { dial?: unknown } | undefined)?.dial;
  return typeof dial === "string" ? dial : null;
}

async function getManagedRouteDialForHost(host: string) {
  const response = await fetch("http://localhost:2019/config/apps/http/servers/srv0/routes", {
    headers: {
      Origin: "http://localhost:2019",
    },
  });
  expect(response.ok).toBe(true);
  const routes = (await response.json()) as unknown[];
  expect(Array.isArray(routes)).toBe(true);
  const route = routes.find((candidate) => {
    return getRouteHosts(candidate).includes(host);
  });

  return getRouteDial(route);
}

async function waitForServerOutput(
  getOutput: () => string,
  expectedText: string,
  timeoutMs = 15_000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const output = getOutput();
    if (output.includes(expectedText)) {
      return;
    }
    await wait(100);
  }

  throw new Error(getOutput());
}

function signalServer(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals) {
  if (child.exitCode !== null) return;

  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child signal if the process group is already gone.
    }
  }

  child.kill(signal);
}

async function requestServerShutdown(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
) {
  signalServer(child, signal);
  await Promise.race([once(child, "exit"), wait(1_500)]);
}

async function stopCompetingServer(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
) {
  if (child.exitCode !== null) return;

  signalServer(child, signal);
  await Promise.race([once(child, "exit"), wait(5_000)]);

  if (child.exitCode !== null) return;

  signalServer(child, "SIGKILL");
  await Promise.race([once(child, "exit"), wait(1_500)]);
}

test("points a reused live hostname to the newest dev server", async () => {
  const explicitDomain = `takeover-${process.pid}-${Date.now().toString(36)}.localtest.me`;
  const firstServer = startServer({
    E2E_DOMAIN: explicitDomain,
  });
  let secondServer: ReturnType<typeof startServer> | null = null;

  try {
    await waitForServerOutput(firstServer.getOutput, `https://${explicitDomain}`);
    secondServer = startServer({
      E2E_DOMAIN: explicitDomain,
    });
    await waitForServerOutput(secondServer.getOutput, `https://${explicitDomain}`);
    const upstreamTarget = extractUpstreamTarget(secondServer.getOutput());
    expect(upstreamTarget).toBeTruthy();
    await expect.poll(() => getManagedRouteDialForHost(explicitDomain)).toBe(upstreamTarget);
  } finally {
    await stopCompetingServer(firstServer.child, "SIGKILL");
    if (secondServer) {
      await stopCompetingServer(secondServer.child);
    }
  }
});

test("keeps several live Vite servers on their own domains", async ({ page }) => {
  const domainLabels = ["a", "b", "c", "d"];
  const domainSuffix = `${process.pid}-${Date.now().toString(36)}`;
  const domains = domainLabels.map((label) => {
    return `multi-${label}-${domainSuffix}.localtest.me`;
  });
  const servers: ReturnType<typeof startServer>[] = [];

  try {
    for (const domain of domains) {
      const server = startServer({
        E2E_DOMAIN: domain,
      });
      servers.push(server);
      await waitForServerOutput(server.getOutput, `https://${domain}`);
    }

    const upstreamTargets = servers.map((server) => {
      return extractUpstreamTarget(server.getOutput());
    });
    upstreamTargets.forEach((upstreamTarget) => {
      expect(upstreamTarget).toBeTruthy();
    });
    expect(new Set(upstreamTargets).size).toBe(domains.length);

    for (let index = 0; index < domains.length; index += 1) {
      await expect
        .poll(() => getManagedRouteDialForHost(domains[index]))
        .toBe(upstreamTargets[index]);

      await page.goto(`https://${domains[index]}`);
      await page.waitForSelector("h1");
      await expect(page.locator("#location")).toContainText(`https://${domains[index]}`);
    }
  } finally {
    for (const server of servers) {
      await stopCompetingServer(server.child);
    }
  }
});

test("releases hostname ownership on SIGINT so the same domain can restart immediately", async () => {
  const explicitDomain = `restart-${process.pid}-${Date.now().toString(36)}.localtest.me`;
  const firstServer = startServer({
    E2E_DOMAIN: explicitDomain,
  });

  try {
    await waitForServerOutput(firstServer.getOutput, `https://${explicitDomain}`);
  } finally {
    await requestServerShutdown(firstServer.child, "SIGINT");
  }

  const secondServer = startServer({
    E2E_DOMAIN: explicitDomain,
  });

  try {
    await waitForServerOutput(secondServer.getOutput, `https://${explicitDomain}`);
  } finally {
    await stopCompetingServer(firstServer.child, "SIGKILL");
    await stopCompetingServer(secondServer.child);
  }
});
