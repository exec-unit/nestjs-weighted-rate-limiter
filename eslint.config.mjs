import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

const sharedRules = {
  // Prefer type imports to avoid value imports of types (tree-shaking)
  '@typescript-eslint/consistent-type-imports': [
    'error',
    { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
  ],

  // Disallow unused variables but allow unused parameters prefixed with _
  '@typescript-eslint/no-unused-vars': [
    'error',
    { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
  ],

  // Require explicit handling of floating promises (critical for Redis ops)
  '@typescript-eslint/no-floating-promises': 'error',

  // No non-null assertions — use proper null checks
  '@typescript-eslint/no-non-null-assertion': 'error',
};

export default tseslint.config(
  // Base recommended ESLint rules
  eslint.configs.recommended,

  // TypeScript-specific rules with type-checking
  ...tseslint.configs.recommendedTypeChecked,

  // Source files — strict public API rules
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      // Enforce explicit return types on public API methods for better DX
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',
    },
  },

  // Test files — relaxed rules, separate tsconfig for type resolution
  {
    files: ['test/**/*.ts'],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...sharedRules,
      // Test files don't need explicit return types
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // Allow 'as unknown as X' casts for mocking in tests
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      // vitest pattern: expect(mock.method).toHaveBeenCalled() passes methods as values
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // Ignore build artifacts and configs
  {
    ignores: ['dist/**', 'node_modules/**', '*.config.ts', '*.config.mjs'],
  },
);
