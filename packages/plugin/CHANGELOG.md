# vite-plugin-caddy-multiple-tls

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
