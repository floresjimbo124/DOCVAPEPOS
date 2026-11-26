import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    react(),
    // Installable on tablets/phones and loads with no internet (app files cached by a service worker).
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'DOCVAPE POS',
        short_name: 'DOCVAPE',
        display: 'standalone',
        start_url: '/',
        theme_color: '#0f766e',
        background_color: '#ffffff',
        icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml' }],
      },
      workbox: { navigateFallback: '/index.html' },
    }),
  ],
  test: { environment: 'node' },
})
