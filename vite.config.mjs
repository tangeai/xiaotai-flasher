import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { validLierdaPublicAssets } from './scripts/lierda-agentboot-file.mjs';

export default defineConfig({
  base: './',
  server: {
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.openai/**'] },
  },
  plugins: [
    react(),
    {
      name: 'verify-lierda-public-assets',
      apply: 'build',
      configResolved({ publicDir }) {
        if (publicDir && !validLierdaPublicAssets(publicDir)) {
          throw new Error('public/lierda 仅允许放置通过大小和 SHA-256 校验的 USB AgentBoot。请把本地资料移到 .openai/。');
        }
      },
    },
  ],
});
