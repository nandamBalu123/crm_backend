'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules', 'coverage', 'storage-data', '.test-storage'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node, ...globals.jest } },
    rules: {
      ...js.configs.recommended.rules,
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', ignoreRestSiblings: true }],
      'no-console': 'warn',
      // Tenant safety (ADR-003): static aggregates bypass the tenant-scope hooks.
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.property.name=/^(sum|max|min|aggregate|increment|decrement)$/][callee.object.name=/^[A-Z][A-Za-z]+$/]:not([callee.object.name=/^(Math|Number|Promise|Object|Array|BigInt)$/])", message: 'Static model aggregates bypass tenant scoping; use findAll with fn() attributes.' },
      ],
    },
  },
  // CLI scripts and seeders report progress on stdout by design.
  { files: ['scripts/**/*.js', 'src/database/seeders/**/*.js'], rules: { 'no-console': 'off' } },
];
