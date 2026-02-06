---
'vite-plugin-caddy-multiple-tls': minor
---

Harden multi-instance reliability for local HTTPS development.

- use deterministic route IDs and replace stale route/tls entries before adding new ones
- serialize Caddy bootstrap with a cross-process lock to avoid startup races
- add `instanceLabel` to derive unique hosts and avoid collisions across projects
- pass Caddy Admin API URL per plugin instance instead of mutable global state
- add targeted stale route cleanup for matching domains
