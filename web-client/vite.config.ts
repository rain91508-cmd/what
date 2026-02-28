import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import wasm from 'vite-plugin-wasm'
import { resolve } from 'path'

// https://github.com/vdesjs/vite-plugin-monaco-editor
// Note: Using @monaco-editor/react which handles its own loading

export default defineConfig({
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@core': resolve(__dirname, 'src/core'),
      '@modules': resolve(__dirname, 'src/modules'),
      '@components': resolve(__dirname, 'src/components'),
      '@services': resolve(__dirname, 'src/services'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@types': resolve(__dirname, 'src/types'),
      '@wasm': resolve(__dirname, 'src/wasm'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'render-vendor': ['regl'],
          'utils-vendor': ['comlink', 'idb', 'zustand', 'protobufjs'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  // Configure Monaco editor loader to use local files
  define: {
    // Use local monaco instead of CDN
    'process.env.MONACO_EDITOR_LOADER_URL': JSON.stringify('/node_modules/monaco-editor/min/vs/loader.js'),
  },
})
