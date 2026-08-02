import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Dashboard-local flat config: the React/browser app (web/) plus the Node
// static server (src/). Shadows the repo-root config for this subtree so the
// browser globals don't trip the Node-focused root rules. TS itself checks
// undefined identifiers, so no-undef stays off (typescript-eslint guidance).
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
