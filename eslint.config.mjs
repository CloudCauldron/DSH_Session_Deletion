import { resolve } from 'node:path';
import js from '@eslint/js';
import { defineConfig, globalIgnores, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  includeIgnoreFile(resolve(import.meta.dirname, '.gitignore')),
  globalIgnores(['lib/**']),
  {
    files: ['eslint.config.mjs', 'test/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }] },
  },
  {
    files: ['test/integration.mjs'],
    // Playwright callbacks run in the browser; the test driver runs in Node.
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // DSH runtime services are loaded dynamically.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  },
  {
    files: ['src/runtime.ts'],
    // Wrappers retain the DSH method receiver while capturing the deletion runtime.
    rules: { '@typescript-eslint/no-this-alias': 'off' },
  },
);
