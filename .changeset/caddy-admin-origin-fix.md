---
'vite-plugin-caddy-multiple-tls': patch
---

Fix Caddy Admin API origin-policy regressions by injecting an Origin header on admin requests, classifying origin-policy failures clearly, and adding the optional `caddyAdminOrigin` plugin option.
