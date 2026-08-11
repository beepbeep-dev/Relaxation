import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `base: './'` emits relative asset URLs, which is what makes the same build
// work unmodified whether it is served from a domain root or from a GitHub
// Pages project subpath like /Relaxation/. Hardcoding the repo name here would
// break local `vite preview` and any fork under a different name.
export default defineConfig({
  base: './',
  // WebXR requires a secure context. `npm run dev` serves over HTTPS with a
  // self-signed cert so the Quest 3 browser will offer the Enter VR button
  // when you hit this machine's LAN address.
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', outDir: 'dist' },
});
