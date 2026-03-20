# vite-plugin-caddy-multiple-tls

## 1.8.0

### Minor Changes

- 0bead09: Export `resolveCaddyTlsDomains()` and `resolveCaddyTlsUrl()` so external tooling can compute the same resolved local HTTPS domains and URL as the plugin.

## 1.7.1

### Patch Changes

- faaa5b4: Fix a shutdown regression where stopping a Vite server could leave hostname ownership behind and block an immediate restart on the same domain.
  - release hostname ownership reliably on `SIGINT` and `SIGTERM`
  - reclaim dead owner records immediately instead of waiting for heartbeat staleness
  - add regression coverage for same-domain restart after terminal shutdown

## 1.7.0

### Minor Changes

- 5b8fb0f: Improve route isolation so one running Vite server no longer takes over another server's hostname by default.
  - add published Vite 8 support in the plugin peer/dev dependency ranges
  - add per-instance ownership records and heartbeat refreshes for managed Caddy routes
  - refuse live hostname conflicts instead of silently replacing another active server
  - reclaim orphaned managed routes and TLS policies when their recorded owner is gone
  - clean up owned Caddy resources if the plugin loses its ownership record
  - add regression coverage for ownership conflicts, stale-owner recovery, and isolation
  - run plugin unit tests and package build in CI

## 1.6.1

### Patch Changes

- 8b84d92: Fix Caddy Admin API origin-policy regressions by injecting an Origin header on admin requests, classifying origin-policy failures clearly, and adding the optional `caddyAdminOrigin` plugin option.

## 1.6.0

### Minor Changes

- d5bd04d: Harden multi-instance reliability for local HTTPS development.
  - use deterministic route IDs and replace stale route/tls entries before adding new ones
  - serialize Caddy bootstrap with a cross-process lock to avoid startup races
  - add `instanceLabel` to derive unique hosts and avoid collisions across projects
  - pass Caddy Admin API URL per plugin instance instead of mutable global state
  - add targeted stale route cleanup for matching domains

## 1.5.1

### Patch Changes

- Fix port routing when Vite auto-increments to a free port after the requested port is already in use.

## 1.5.0

### Minor Changes

- Default Vite HMR config to use the resolved domain over WSS on port 443 when users do not specify HMR settings, isolating multiple instances.

## 1.4.2

### Patch Changes

- default Vite host/allowedHosts settings for proxy-friendly local domains

## 1.4.1

### Patch Changes

- fix reverse_proxy request header override shape for Caddy

## 1.4.0

### Minor Changes

- add upstreamHostHeader option to override the upstream Host header

## 1.3.0

### Minor Changes

- 2c1ee4f: feat: add support for vite preview server

## 1.2.0

### Minor Changes

- 40aa5b5: Add loopback domain support, improve Astro upstream resolution, sync README on build, and remove the chalk dependency.

## 1.1.0

### Minor Changes

- e5490a2: Add loopback domain support, README sync on build, and remove the chalk dependency.

## 1.0.0

### Major Changes

- cfd1f0f: Initial release.
