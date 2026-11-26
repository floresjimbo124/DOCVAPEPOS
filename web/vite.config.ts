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
        theme_color: '#1f1f1f',
        background_color: '#161616',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
      workbox: { navigateFallback: '/index.html' },
    }),
  ],
  test: { environment: 'node' },
})
