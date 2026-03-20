import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect } from "@playwright/test";

function resolveRepoRoot() {
  return path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
}

function startCompetingServer() {
  return startServer();
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

test("refuses to steal a live hostname from another dev server", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector("h1");
  await expect(page.locator("#location")).toContainText("https://");
  await expect(
    page.getByRole("heading", { name: "Vite Plugin Caddy with multiple TLS" }),
  ).toBeVisible();

  const competingServer = startCompetingServer();

  try {
    await expect.poll(() => competingServer.getOutput()).toContain("already owns this domain");
  } finally {
    await stopCompetingServer(competingServer.child);
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
