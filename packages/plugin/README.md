# vite-plugin-multiple-caddy

Vite plugin that runs Caddy to proxy local development traffic over HTTPS with
derived domains like `<repo>.<branch>.localhost`.

## Install

```sh
npm install -D vite-plugin-multiple-caddy
```

## Usage

```js
import { defineConfig } from 'vite';
import caddyTls from 'vite-plugin-multiple-caddy';

export default defineConfig({
  plugins: [caddyTls()],
});
```

## Options

- `domain`: explicit domain to proxy without repo/branch derivation
- `baseDomain`: base domain to build `<repo>.<branch>.<baseDomain>` (defaults to `localhost`)
- `repo`, `branch`: override repo/branch names used for derived domains
- `internalTls`: use Caddy internal CA for provided domains
