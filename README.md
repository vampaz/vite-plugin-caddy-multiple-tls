# vite-plugin-multiple-caddy

> [!WARNING]
> THIS PLUGIN IS HIGHLY EXPERIMENTAL AND UNSTABLE, USE WITH CAUTION

## Usage

```js
// vite.config.js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-multiple-caddy';

const config = defineConfig({
  plugins: [
    caddyTls({
      domains: ['this.is.cool.localhost', 'something-else.localhost'],
      internalTls: true,
    })
  ]
});

export default config;
```

Will give this in the terminal, allow you to connect to your app on HTTPS with a self-signed and trusted cert.
```
> vite


🔒 Caddy is running to proxy your traffic on https

🔗 Access your local servers 
🌍 https://this.is.cool.localhost
🌍 https://something-else.localhost

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
      internalTls: true,
    })
  ]
});

export default config;
```

You can override auto-detection with `repo` or `branch` if needed.

For a zero-config experience, use `baseDomain: 'localhost'` so the derived domain works without editing `/etc/hosts`.

For non-`.localhost` domains (like `local.example.test`), set `internalTls: true` to force Caddy to use its internal CA for certificates.

## Development
This repo uses npm workspaces. Install from the root with `npm install`, then run workspace scripts like `npm run build --workspace packages/plugin` or `npm run dev --workspace playground`.

## Contributing
See [CONTRIBUTING.md](./CONTRIBUTING.md) to see how to get started.
 
## License

MIT
