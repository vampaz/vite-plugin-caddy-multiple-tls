# Plan: Make `vite-plugin-caddy-multiple-tls` robust for many concurrent local Vite instances

## Review findings (prioritized)

### P0 - Stale route can shadow the new route for the same domain
- File: `packages/plugin/src/index.ts:258`
- File: `packages/plugin/src/utils.ts:304`
- File: `packages/plugin/src/utils.ts:352`
- Current behavior: each run creates a random `routeId` and appends a new route. If a process crashes (no cleanup), stale route remains. On next run with same domain, new route is appended after stale one.
- Risk: Caddy evaluates routes in order; stale route with `terminal: true` can match first and proxy to dead port. This creates intermittent outages and breaks repeatability.

### P0 - Race when multiple projects start simultaneously and Caddy is initially down
- File: `packages/plugin/src/index.ts:452`
- File: `packages/plugin/src/utils.ts:60`
- Current behavior: instances concurrently check `isCaddyRunning()`, then call `caddy start`. A loser in the race can treat `caddy start` as failure and abort setup.
- Risk: when booting many projects together, some instances fail to register routes even though Caddy eventually runs.

### P1 - Auto-derived domain collisions across unrelated projects
- File: `packages/plugin/src/index.ts:66`
- File: `packages/plugin/src/index.ts:143`
- Current behavior: domain is `<repo-basename>.<branch>.<baseDomain>`. Different repos with same basename and branch collide (e.g. multiple `web` repos on `main`).
- Risk: routes and cert subjects collide, causing nondeterministic routing and cross-project interference.

### P1 - Global mutable Admin API URL can leak across plugin instances in one process
- File: `packages/plugin/src/utils.ts:5`
- File: `packages/plugin/src/index.ts:203`
- Current behavior: `setCaddyApiUrl` mutates a module-global variable.
- Risk: multiple plugin instances in a single Node process cannot safely target different Caddy Admin API endpoints.

### P2 - No self-healing cleanup for orphaned routes/policies
- File: `packages/plugin/src/index.ts:386`
- Current behavior: cleanup is signal/close-driven only.
- Risk: `SIGKILL`, crashes, or machine reboots leave route/policy debris and eventual config bloat.

## Improvement plan

1. Make route registration idempotent per instance key
- Add stable `instanceKey` derived from `{domainArray, process.cwd(), server.config.root}` (normalized + hash).
- Use deterministic IDs:
  - `routeId = vite-proxy-${instanceKey}`
  - `tlsPolicyId = vite-proxy-${instanceKey}-tls`
- Before adding route, delete existing route with same `routeId` (`DELETE /id/<routeId>`), then add.
- Keep `terminal: true` but guarantee replacement instead of blind append.
- Verify:
  - Restarting same project after simulated unclean stop still serves correct upstream.
  - No duplicate routes for same instance key.

2. Serialize Caddy bootstrap/start with cross-process lock
- Add a lightweight lock file strategy in temp dir (`os.tmpdir()`), e.g. `vite-caddy-tls.lock`.
- Inside lock: `isCaddyRunning` check + `startCaddy` + `ensureBaseConfig`.
- On `caddy start` failure, immediately re-check `isCaddyRunning` before giving up.
- Verify:
  - Parallel startup test with N processes results in all routes registered.
  - No startup abort due only to start race.

3. Add explicit uniqueness option for domain derivation
- Add option: `instanceLabel?: string`.
- Domain derivation:
  - If `domain` provided, keep as-is.
  - Else derive `<repo>.<branch>[.<instanceLabel>].<baseDomain>` (sanitize label).
- Default behavior stays backward-compatible (no label unless provided).
- Verify:
  - Two projects with same repo basename + branch can run together when labels differ.

4. Add orphan cleanup strategy (safe and bounded)
- Add metadata to routes via `@id` only (already present) plus predictable prefix.
- On plugin start, run optional cleanup of stale `vite-proxy-*` entries that match same domain or same deterministic key before add.
- Keep this scoped; do not delete foreign routes.
- Verify:
  - Repeated crash/restart cycles do not accumulate broken duplicates.

5. Remove global API URL mutation
- Refactor utils to accept `apiUrl` parameter per operation or create a bound client object per plugin instance.
- Keep public API internal to package (no breaking external API required).
- Verify:
  - Two plugin instances in same process with different `caddyApiUrl` do not interfere.

6. Strengthen tests for concurrency and collision cases
- Unit tests:
  - stale route replacement behavior
  - concurrent start path with one `caddy start` loser
  - deterministic id generation
  - `instanceLabel` derivation and sanitization
- E2E tests (minimal, reliable):
  - launch two playground servers with same repo/branch but different labels; both reachable over HTTPS
  - kill one process abruptly, restart, confirm routing still points to live port

## Execution order

1. Deterministic IDs + replace-before-add route flow.
2. Startup lock + race-safe `startCaddy` fallback check.
3. `instanceLabel` option and docs.
4. Per-instance API client refactor.
5. Test suite expansion.
6. Optional targeted stale cleanup.

## Success criteria

- Multiple Vite projects can start concurrently without intermittent route registration failures.
- Restarting any project after unclean termination does not get stuck behind stale routes.
- Domain collisions are avoidable without forcing manual `domain` for every project.
- Caddy config remains bounded and stable during repeated local workflows.
