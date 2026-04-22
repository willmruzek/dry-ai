import { recommended } from '@willmruzek/my-toolkit/eslint';

const base = Array.isArray(recommended) ? recommended : [recommended];

export default [
  ...base,
  {
    // Compiled output — lint `src/` instead; avoids `no-undef` on Node globals in emitted JS.
    ignores: ['dest/**', 'dist/**', 'coverage/**', 'vitest.config.ts'],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      // Toolkit `recommended` prefers `interface`; this project prefers `type`.
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
    },
  },
  {
    files: ['tests/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-misused-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
];
