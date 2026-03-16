---
'vite-plugin-caddy-multiple-tls': minor
---

Improve route isolation so one running Vite server no longer takes over another server's hostname by default.

- add published Vite 8 support in the plugin peer/dev dependency ranges
- add per-instance ownership records and heartbeat refreshes for managed Caddy routes
- refuse live hostname conflicts instead of silently replacing another active server
- reclaim orphaned managed routes and TLS policies when their recorded owner is gone
- clean up owned Caddy resources if the plugin loses its ownership record
- add regression coverage for ownership conflicts, stale-owner recovery, and isolation
- run plugin unit tests and package build in CI
