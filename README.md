# vite-plugin-multiple-caddy


## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-multiple-caddy';

const config = defineConfig({
  plugins: [
    caddyTls(),
  ]
});

export default config;
```

Will give this in the terminal, allow you to connect to your app on HTTPS with a self-signed and trusted cert.
```
> vite


🔒 Caddy is running to proxy your traffic on https

🔗 Access your local server 
🌍 https://my-repo.my-branch.localhost

```

By default, the plugin derives `<repo>.<branch>.localhost` from git.

If you want a fixed host without repo/branch in the URL, pass a single domain:

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-multiple-caddy';

const config = defineConfig({
  plugins: [
    caddyTls({
      domain: 'app.localhost',
    })
  ]
});

export default config;
```

To derive a domain like `<repo>.<branch>.<baseDomain>` automatically from git (repo name first, then branch):

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-multiple-caddy';

const config = defineConfig({
  plugins: [
    caddyTls({
      baseDomain: 'local.conekto.eu',
    })
  ]
});

export default config;
```

You can override auto-detection with `repo` or `branch` if needed.

For a zero-config experience, use `baseDomain: 'localhost'` (the default) so the derived domain works without editing `/etc/hosts`.

`internalTls` defaults to `true` when you pass `baseDomain` or `domain`. You can override it if needed.

For non-`.localhost` domains (like `local.example.test`), keep `internalTls: true` to force Caddy to use its internal CA for certificates.

> [!IMPORTANT]  
> **Hosts file limitation:** If you use a custom domain, you must **manually** add each generated subdomain to your `/etc/hosts` file (e.g., `127.0.0.1 repo.branch.local.example.test`). System hosts files **do not support wildcards** (e.g., `*.local.example.test`), so you lose the benefit of automatic domain resolution that `localhost` provides.

## Recommended base domain: `.localhost`
Why `localhost` is the best option for local development:
- Reserved by RFC 6761 (never on the public internet).
- Automatic resolution: `*.localhost` maps to `127.0.0.1` and `::1` without DNS or `/etc/hosts`.
- Subdomain support: `api.localhost`, `foo.bar.localhost`, etc.
- Secure context in browsers for HTTPS, service workers, and cookies.
- Works well with Caddy and other local reverse proxies.

Example usage:
```
app.localhost
api.app.localhost
```

## Development
This repo uses npm workspaces. Install from the root with `npm install`, then run workspace scripts like `npm run build --workspace packages/plugin` or `npm run dev --workspace playground`.

## Contributing
See [CONTRIBUTING.md](./CONTRIBUTING.md) to see how to get started.
 
## License

MIT
