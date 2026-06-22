import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // SWC handles TypeScript transformation with emitDecoratorMetadata support.
    // Required for @nestjs/testing DI in E2E tests (esbuild cannot emit decorator metadata).
    swc.vite({ module: { type: 'es6' } }),
  ],
  test: {
    environment: 'node',

    // Unit tests: fast, no containers
    // Integration / E2E tests: need Docker, run separately
    include: ['test/**/*.spec.ts'],

    // Testcontainers may take up to 2 minutes to pull images on slow connections
    testTimeout: 120_000,
    hookTimeout: 180_000,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Exclude barrel and type-only files — they carry no executable logic
      exclude: ['src/index.ts', 'src/**/*.d.ts', 'src/interfaces/**', 'src/constants/**'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
