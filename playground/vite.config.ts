import { defineConfig } from 'vite';
import caddyTls from '../packages/plugin/src/index.js';
import { playgroundBaseDomain } from './base-domain.js';

const config = defineConfig({
  server: {
    port: 3000,
    host: true,
    // allowedHosts: true,
  },
  plugins: [
    caddyTls(
      {
        baseDomain: playgroundBaseDomain,
      }
    ),
  ],
});

export default config;
