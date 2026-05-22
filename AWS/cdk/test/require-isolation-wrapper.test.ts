import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

// CJS interop: rule file is a plain .js CommonJS module
import rule = require('../eslint/rules/require-isolation-wrapper');

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tseslint.parser, // required to parse TypeScript type annotations
  },
});

tester.run('require-isolation-wrapper', rule, {
  // ── Cases that must NOT trigger the rule ─────────────────────────────────

  valid: [
    {
      // Correct: handler is wrapped with withClientIsolation
      code: `export const handler = withClientIsolation(async (event, clientId) => {
        return { statusCode: 200, body: 'ok' };
      });`,
    },
    {
      // Non-handler export — rule only targets 'handler'
      code: `export const helper = async (event: unknown) => {};`,
    },
    {
      // Non-exported handler — rule only targets exported declarations
      code: `const handler = async (event: unknown) => {};`,
    },
    {
      // Unrelated named export
      code: `export const TIMEOUT_MS = 5000;`,
    },
  ],

  // ── Cases that MUST trigger the rule ─────────────────────────────────────

  invalid: [
    {
      // Bare async arrow function — the most common accidental bypass
      code: `export const handler = async (event: unknown) => {
        return { statusCode: 200 };
      };`,
      errors: [{ messageId: 'missingWrapper' }],
    },
    {
      // Wrong wrapper name — must be specifically withClientIsolation
      code: `export const handler = someOtherMiddleware(async (event: unknown) => {});`,
      errors: [{ messageId: 'missingWrapper' }],
    },
    {
      // Async function expression instead of arrow function
      code: `export const handler = async function(event: unknown) {
        return { statusCode: 200 };
      };`,
      errors: [{ messageId: 'missingWrapper' }],
    },
    {
      // Handler assigned directly to an imported function reference (no wrapper)
      code: `export const handler = bareFunction;`,
      errors: [{ messageId: 'missingWrapper' }],
    },
  ],
});

// RuleTester throws on failure, so reaching this line means all cases passed.
test('require-isolation-wrapper rule enforces withClientIsolation on all handler exports', () => {
  expect(true).toBe(true);
});
