import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // apps/dashboard/public is hand-written browser JS (no build, no Node
  // globals) — outside this Node-focused lint setup, like the inline page scripts.
  { ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', 'apps/dashboard/public/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Zero `any` is a project rule (brief §0/§6), not a suggestion.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
);
