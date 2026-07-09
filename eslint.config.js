import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

// Flat config. Vendored PDF.js and build artifacts are ignored; the TypeScript
// source under src/ and eval/ is linted with typescript-eslint's recommended
// rules. Prettier's config is applied last to disable stylistic rules it owns.
export default tseslint.config(
  {
    ignores: [
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'public/**',
      'coverage/**',
    ],
  },
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
