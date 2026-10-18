import { defineConfig } from 'vitest/config';
import path from 'path';
import react from '@vitejs/plugin-react';

// Node 20.18.x cannot `require()` an ESM-only dependency, which jsdom reaches
// through html-encoding-sniffer → @exodus/bytes. Enabling the (experimental)
// require-module bridge in the test workers lets the jsdom environment load, so
// `npx vitest run` works with no external env var. Config-only: no dependency
// or product-code change. Workers inherit NODE_OPTIONS from this process.
const NODE_OPTIONS_FLAG = '--experimental-require-module';
if (!String(process.env.NODE_OPTIONS || '').includes(NODE_OPTIONS_FLAG)) {
  process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, NODE_OPTIONS_FLAG].filter(Boolean).join(' ');
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.')
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'tests/setup.ts',
        '**/*.config.{ts,js}',
        '**/*.d.ts',
        'dist/',
        'build/',
      ],
      thresholds: {
        statements: 50,
        branches: 50,
        functions: 50,
        lines: 50,
      },
    },
    // Test timeout
    testTimeout: 10000,
    // Hook timeout
    hookTimeout: 10000,
    // Retry failed tests
    retry: 0,
    // Number of concurrent workers
    threads: true,
    // Clear mock history between tests
    clearMocks: true,
    // Restore mock state between tests
    restoreMocks: true,
  },
});
