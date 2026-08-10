import js from '@eslint/js';
import ts from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '.pnpm-store/**',
      'legacy/**',
      'ctrial/**',
    ],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  { files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs', '**/*.cjs'] },
];
