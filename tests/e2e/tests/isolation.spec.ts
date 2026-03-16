import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

function resolveRepoRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
}

function startCompetingServer() {
  return startServer();
}

function startServer(envOverrides: Record<string, string> = {}) {
  const child = spawn('npm', ['run', 'dev', '--workspace', 'playground'], {
    cwd: resolveRepoRoot(),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';

  child.stdout.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    output += chunk.toString();
  });

  return {
    child,
    getOutput() {
      return output;
    },
  };
}

async function stopCompetingServer(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = 'SIGTERM',
) {
  if (child.exitCode !== null) return;

  child.kill(signal);
  await once(child, 'exit');
}

test('refuses to steal a live hostname from another dev server', async ({ page }) => {
  const competingServer = startCompetingServer();

  try {
    await expect.poll(() => {
      return competingServer.getOutput();
    }).toContain('already owns this domain');

    await page.goto('/');
    await page.waitForSelector('h1');
    await expect(page.locator('#location')).toContainText('https://');
    await expect(
      page.getByRole('heading', { name: 'Vite Plugin Caddy with multiple TLS' }),
    ).toBeVisible();
  } finally {
    await stopCompetingServer(competingServer.child);
  }
});

test('releases hostname ownership on SIGINT so the same domain can restart immediately', async () => {
  const explicitDomain = 'restart.localtest.me';
  const firstServer = startServer({
    E2E_DOMAIN: explicitDomain,
  });

  try {
    await expect.poll(() => {
      return firstServer.getOutput();
    }).toContain(`https://${explicitDomain}`);
  } finally {
    await stopCompetingServer(firstServer.child, 'SIGINT');
  }

  const secondServer = startServer({
    E2E_DOMAIN: explicitDomain,
  });

  try {
    await expect.poll(() => {
      return secondServer.getOutput();
    }).toContain(`https://${explicitDomain}`);
    await expect.poll(() => {
      return secondServer.getOutput();
    }).not.toContain('already owns this domain');
  } finally {
    await stopCompetingServer(secondServer.child);
  }
});
