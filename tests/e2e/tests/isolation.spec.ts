import { once } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

function resolveRepoRoot() {
  return path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
}

function startCompetingServer() {
  const child = spawn('npm', ['run', 'dev', '--workspace', 'playground'], {
    cwd: resolveRepoRoot(),
    env: {
      ...process.env,
      FORCE_COLOR: '0',
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

async function stopCompetingServer(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null) return;

  child.kill('SIGTERM');
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
