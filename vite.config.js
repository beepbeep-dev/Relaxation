import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// WebXR requires a secure context. `npm run dev` serves over HTTPS with a
// self-signed cert so the Quest 3 browser will offer the Enter VR button
// when you hit this machine's LAN address.
export default defineConfig({
  plugins: [basicSsl()],
  server: { host: true, port: 5173 },
  build: { target: 'es2022', outDir: 'dist' },
});
