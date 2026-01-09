import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../src/TeamsMediaBot/wwwroot'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'https://localhost:9441',
        changeOrigin: true,
        secure: false,
      },
      '/hubs': {
        target: 'https://localhost:9441',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
  },
})
