# Project Understanding & Enhancements Plan

## Execution Summary

### Current understanding
- Purpose: Run a single shared Caddy instance on :443 and dynamically add/remove routes per Vite dev/preview server using Caddy Admin API so multiple projects can coexist.
- Domain derivation: Default `<repo>.<branch>.localhost` via git; can override with `domain`, `baseDomain`, `repo`, `branch`, `loopbackDomain`.
- TLS: Uses Caddy internal CA when `domain`/`baseDomain`/`loopbackDomain` provided; adds TLS policy per route.
- Routing: Adds route via `/config/apps/http/servers/<serverName>/routes` with reverse_proxy to resolved host/port. Optional CORS header injection and upstream Host override.
- Lifecycle: Ensures Caddy running, ensures base config `srv0`, adds route + TLS policy, removes on server close or SIGINT/SIGTERM.
- Host/port resolution: Uses `server.resolvedUrls`, HTTP server address, config server/preview settings, and fallback ports (5173/4173).

### Enhancement opportunities

#### DX (High impact / Low–Med effort)
- Better logging when domain resolution fails: show which inputs were missing, and suggest `repo`/`branch`/`domain`.
- Print effective upstream target (host:port) in logs to reduce confusion when non-default ports/hosts.
- Add a “dry-run” or “verbose” mode to display computed config without touching Caddy.

#### Reliability (High impact / Med effort)
- Retry/remove route cleanup on shutdown with a short backoff to avoid leaving stale routes when Admin API is momentarily unavailable.
- Guard against routeId collisions by including pid or unique suffix.
- Ensure TLS policy removal only if it was successfully created (already tracked, but add stronger checks for overlap cases).

#### Config surface (Medium impact / Low effort)
- Allow multiple domains (array) rather than single derived/explicit domain.
- Support custom admin API URL/port for non-default Caddy setups.

#### Tests (High impact / Med effort)
- Add tests for domain normalization/sanitization, loopbackDomain, and upstreamHost resolution edge cases (IPv6, 0.0.0.0, ::).
- Add tests for TLS policy overlap handling and cleanup flow.

#### Docs (Medium impact / Low effort)
- Clarify when `internalTls` defaults to true; explain how to disable.
- Add a “Troubleshooting” section (Caddy not found, Admin API blocked, host resolution issues).

### Prioritized proposal
1. Improve failure logs for domain resolution and Caddy admin errors (High/Low, low risk).
2. Add target info to success logs (host/port, domain) (High/Low, low risk).
3. Add config option for Caddy Admin API URL (Med/Low, low risk).
4. Expand unit tests around domain normalization and host/port resolution (High/Med, low risk).
5. Add explicit multi-domain support (Med/Med, moderate risk if API expects array; but Caddy supports host matcher array).
6. Add cleanup retries/backoff (High/Med, low risk if capped).
