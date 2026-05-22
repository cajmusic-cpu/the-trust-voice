import tseslint from 'typescript-eslint';
import { createRequire } from 'module';

// Import CommonJS rule from an ES module context
const require = createRequire(import.meta.url);
const requireIsolationWrapper = require('./eslint/rules/require-isolation-wrapper');

export default [
  // Never lint compiled output or dependencies
  {
    ignores: ['cdk.out/**', 'node_modules/**', '**/*.js', '**/*.d.ts'],
  },

  // TypeScript rules for all source files
  ...tseslint.configs.recommended,

  // Isolation enforcement — Lambda handler files only.
  // Any file under lambdas/ that exports `handler` without withClientIsolation
  // is a build error. This catches bypass at the IDE and in CI before deploy.
  {
    files: ['lambdas/**/*.ts'],
    plugins: {
      'trust-voice': {
        rules: {
          'require-isolation-wrapper': requireIsolationWrapper,
        },
      },
    },
    rules: {
      'trust-voice/require-isolation-wrapper': 'error',
    },
  },
];
