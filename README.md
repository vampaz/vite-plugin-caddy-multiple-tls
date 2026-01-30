# vite-plugin-caddy-multiple-tls

## What it does
Runs Caddy alongside Vite to give you HTTPS locally with automatic, per-branch domains like `<repo>.<branch>.localhost`, so you can use real hostnames, cookies, and secure APIs without manual proxy setup.

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-caddy-multiple-tls';

const config = defineConfig({
  plugins: [
    caddyTls(),
  ]
});

export default config;
```

Will give this in the terminal, allow you to connect to your app on HTTPS with a self-signed and trusted cert.

The plugin defaults `server.host = true` and `server.allowedHosts = true` (plus preview equivalents) so custom hostnames work without extra config. Override these in your Vite config if you need different values.
```
> vite


🔒 Caddy is proxying your traffic on https

🔗 Access your local server
🌍 https://my-repo.my-branch.localhost

```

By default, the plugin derives `<repo>.<branch>.localhost` from git.
If repo or branch can't be detected, pass `repo`/`branch` or use `domain`.

If you want a fixed host without repo/branch in the URL, pass a single domain:

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-caddy-multiple-tls';

const config = defineConfig({
  plugins: [
    caddyTls({
      domain: 'app.localhost',
    })
  ]
});

export default config;
```

You can also pass multiple explicit domains:

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-caddy-multiple-tls';

const config = defineConfig({
  plugins: [
    caddyTls({
      domain: ['app.localhost', 'api.localhost'],
    })
  ]
});

export default config;
```

To derive a domain like `<repo>.<branch>.<baseDomain>` automatically from git (repo name first, then branch):

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-caddy-multiple-tls';

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

If your Caddy Admin API is not on the default `http://localhost:2019`, set `caddyApiUrl`:

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-caddy-multiple-tls';

const config = defineConfig({
  plugins: [
    caddyTls({
      caddyApiUrl: 'http://localhost:2020',
    })
  ]
});

export default config;
```

> [!IMPORTANT]  
> **Hosts file limitation:** If you use a custom domain, you must **manually** add each generated subdomain to your `/etc/hosts` file (e.g., `127.0.0.1 repo.branch.local.example.test`). System hosts files **do not support wildcards** (e.g., `*.local.example.test`), so you lose the benefit of automatic domain resolution that `localhost` provides.

## Recommended base domain: `.localhost`
Why `localhost` is the best option for local development:
- Reserved by RFC 6761 (never on the public internet).
- Automatic resolution on macOS: `*.localhost` maps to `127.0.0.1` and `::1` without DNS or `/etc/hosts`.
- Subdomain support: `api.localhost`, `foo.bar.localhost`, etc.
- Secure context in browsers for HTTPS, service workers, and cookies.
- Works well with Caddy and other local reverse proxies.

Example usage:
```
app.localhost
api.app.localhost
```

> [!NOTE]
> **Linux users:** Unlike macOS, most Linux distributions don't automatically resolve `*.localhost` subdomains. The plugin will detect Linux and show you the exact command to run:
> ```
> 🐧 Linux users: if the domain doesn't resolve, run:
>    echo "127.0.0.1 my-repo.my-branch.localhost" | sudo tee -a /etc/hosts
> ```
>
> If you want to avoid `/etc/hosts` edits on Linux, set `loopbackDomain` to a public loopback domain:
> ```ts
> caddyTls({
>   loopbackDomain: 'localtest.me',
> })
> ```
> Supported values: `localtest.me`, `lvh.me`, `nip.io` (maps to `127.0.0.1.nip.io`). These rely on public DNS, so they can fail offline or on restricted networks.
>
> Why these work: they use wildcard DNS so any subdomain resolves to `127.0.0.1`, meaning the request loops back to your machine after DNS.
> - `localtest.me` and `lvh.me`: static wildcard -> always `127.0.0.1` (great for subdomain testing).
> - `nip.io`: dynamic parsing of the IP in the hostname (e.g. `app.192.168.1.50.nip.io`) so you can target LAN devices.
> Why use them: subdomains behave like real domains, no `/etc/hosts` edits, and closer parity for cookies/CORS rules.
>
> When using loopback domains, ensure your Vite config allows the Host header and binds to all interfaces, e.g. `server: { allowedHosts: true, host: true }`.
>
> For a permanent fix that handles all `*.localhost` domains automatically, install dnsmasq:
> ```bash
> sudo apt install dnsmasq
> echo "address=/.localhost/127.0.0.1" | sudo tee /etc/dnsmasq.d/localhost.conf
> sudo systemctl restart dnsmasq
> ```

## Development
This repo uses npm workspaces. Install from the root with `npm install`, then run workspace scripts like `npm run build --workspace packages/plugin` or `npm run dev --workspace playground`.

The published package README is synced from the root `README.md` via `packages/plugin/scripts/sync-readme.sh`.

## Contributing
See [CONTRIBUTING.md](./CONTRIBUTING.md) to see how to get started.
 
## License

MIT
