import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'
import electron from 'vite-plugin-electron/simple'

const sharedAlias = fileURLToPath(new URL('./src/shared', import.meta.url))

export default defineConfig({
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'src/main/index.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': sharedAlias,
            },
          },
          build: {
            rollupOptions: {
              external: ['electron-store', 'ws'],
            },
          },
        },
      },
      preload: {
        input: 'src/preload/index.ts',
        vite: {
          resolve: {
            alias: {
              '@shared': sharedAlias,
            },
          },
        },
      },
    }),
  ],
  resolve: {
    alias: {
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@shared': sharedAlias,
    },
  },
})
