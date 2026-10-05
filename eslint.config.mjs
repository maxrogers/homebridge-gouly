import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'python/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off', // bridge messages and HAP values are untyped JSON
      '@typescript-eslint/no-require-imports': 'off', // package.json is read with require
      'no-unused-vars': 'off', // the TypeScript rule below understands types and parameter properties
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  { files: ['homebridge-ui/public/**/*.js'], languageOptions: { sourceType: 'script', globals: { ...globals.browser, homebridge: 'readonly' } } },
  { files: ['homebridge-ui/server.js', 'eslint.config.mjs'], languageOptions: { sourceType: 'module', globals: globals.node } },
  { files: ['test/**/*.js'], languageOptions: { sourceType: 'commonjs', globals: globals.node } },
  { files: ['**/*.js', '**/*.mjs'], rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }] } },
);
