import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vinext from 'vinext';

// Separate from the Windows/Cloudflare dev configuration: no Worker emulator,
// no .dev.vars, no build-time secret injection, no platform-specific D1 path.
export default defineConfig({
  plugins: [vinext()],
  resolve: { alias: { 'cloudflare:workers': fileURLToPath(new URL('./server/bindings.mjs', import.meta.url)) } },
});
