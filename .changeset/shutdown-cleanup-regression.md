---
'vite-plugin-caddy-multiple-tls': patch
---

Fix a shutdown regression where stopping a Vite server could leave hostname ownership behind and block an immediate restart on the same domain.

- release hostname ownership reliably on `SIGINT` and `SIGTERM`
- reclaim dead owner records immediately instead of waiting for heartbeat staleness
- add regression coverage for same-domain restart after terminal shutdown
