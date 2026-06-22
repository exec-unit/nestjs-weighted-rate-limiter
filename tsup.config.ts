import { defineConfig } from 'tsup';

export default defineConfig({
  // With bundle: false, we need to provide all source files as entry points
  // so tsup can transpile them individually while preserving folder structure.
  entry: ['src/**/*.ts', '!src/**/*.spec.ts'],

  format: ['esm', 'cjs'],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  bundle: false,

  // Node.js 18+ minimum — matches NestJS v10/v11 requirement
  target: 'node18',

  // keepNames prevents minification from mangling class names,
  // which would break NestJS Logger and error messages
  esbuildOptions(options) {
    options.keepNames = true;
  },
});
