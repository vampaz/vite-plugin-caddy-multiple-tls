import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

test.skip(Boolean(process.env.E2E_PREVIEW), "Dev-server isolation is covered by the dev e2e run.");

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

async function waitForServerOutput(
  getOutput: () => string,
  expectedText: string,
  timeoutMs = 15_000,
) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const output = getOutput();
    if (output.includes("already owns this domain")) {
      throw new Error(output);
    }
    if (output.includes(expectedText)) {
      return;
    }
    await wait(100);
  }

  throw new Error(getOutput());
}

function extractUpstreamTarget(output: string) {
  return output.match(/Upstream target: http:\/\/([^\s]+)/)?.[1] ?? null;
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

function getRouteDial(route: unknown): string | null {
  if (!route || typeof route !== "object") return null;
  const maybeRoute = route as { handle?: unknown; routes?: unknown; upstreams?: unknown };

  if (Array.isArray(maybeRoute.upstreams)) {
    const upstream = maybeRoute.upstreams[0];
    if (upstream && typeof upstream === "object" && "dial" in upstream) {
      const dial = (upstream as { dial?: unknown }).dial;
      return typeof dial === "string" ? dial : null;
    }
  }

  for (const key of ["handle", "routes"] as const) {
    const children = maybeRoute[key];
    if (!Array.isArray(children)) continue;

    for (const child of children) {
      const dial = getRouteDial(child);
      if (dial) return dial;
    }
  }

  return null;
}

async function getManagedRouteDialForHost(host: string) {
  const response = await fetch("http://localhost:2019/config/apps/http/servers/srv0/routes", {
    headers: {
      Origin: "http://localhost:2019",
    },
  });
  if (!response.ok) return null;

  const routes = await response.json();
  if (!Array.isArray(routes)) return null;

  const route = routes.find((candidate: unknown) => {
    if (!candidate || typeof candidate !== "object" || !("@id" in candidate)) return false;
    const id = (candidate as { "@id"?: unknown })["@id"];
    return (
      typeof id === "string" &&
      id.startsWith("vite-proxy-") &&
      getRouteHosts(candidate).includes(host)
    );
  });

  if (!route) return null;
  return getRouteDial(route);
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
    const secondUpstream = extractUpstreamTarget(secondServer.getOutput());

    expect(secondUpstream).toBeTruthy();
    await expect(async () => {
      expect(await getManagedRouteDialForHost(explicitDomain)).toBe(secondUpstream);
    }).toPass();
  } finally {
    await stopCompetingServer(firstServer.child, "SIGKILL");
    if (secondServer) {
      await stopCompetingServer(secondServer.child);
    }
  }
});

test("keeps several live Vite servers on their own domains", async () => {
  const runId = `${process.pid}-${Date.now().toString(36)}`;
  const domains = ["a", "b", "c", "d"].map((label) => {
    return `multi-${label}-${runId}.localtest.me`;
  });
  const servers = domains.map((explicitDomain) => {
    return startServer({
      E2E_DOMAIN: explicitDomain,
    });
  });

  try {
    for (const [index, server] of servers.entries()) {
      await waitForServerOutput(server.getOutput, `https://${domains[index]}`);
    }

    const upstreamTargets = servers.map((server) => extractUpstreamTarget(server.getOutput()));
    expect(upstreamTargets.every(Boolean)).toBe(true);
    expect(new Set(upstreamTargets).size).toBe(domains.length);

    for (const [index, domain] of domains.entries()) {
      await expect(async () => {
        expect(await getManagedRouteDialForHost(domain)).toBe(upstreamTargets[index]);
      }).toPass();
    }
  } finally {
    await Promise.all(servers.map((server) => stopCompetingServer(server.child)));
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
