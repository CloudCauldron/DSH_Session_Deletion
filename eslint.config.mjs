import { resolve } from 'node:path';
import js from '@eslint/js';
import { defineConfig, globalIgnores, includeIgnoreFile } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  includeIgnoreFile(resolve(import.meta.dirname, '.gitignore')),
  globalIgnores(['lib/**']),
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
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
