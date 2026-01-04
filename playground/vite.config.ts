import { defineConfig } from 'vite';
import caddyTls from '../packages/plugin/src/index.js';

const config = defineConfig({
  server: {
    port: 3000,
    host: true,
    // allowedHosts: true,
  },
  plugins: [
    caddyTls(
      // {
      //   baseDomain: 'mine.fu',
      // }
    ),
  ],
});

export default config;
