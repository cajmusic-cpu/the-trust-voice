'use strict';

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Lambda handler exports must be wrapped with withClientIsolation()',
      recommended: true,
    },
    messages: {
      missingWrapper:
        "Lambda 'handler' export must be wrapped with withClientIsolation(). " +
        'Unwrapped handlers bypass client data isolation and expose cross-client data access.',
    },
    schema: [],
  },

  create(context) {
    return {
      ExportNamedDeclaration(node) {
        if (!node.declaration || node.declaration.type !== 'VariableDeclaration') return;

        for (const declarator of node.declaration.declarations) {
          if (
            declarator.id.type !== 'Identifier' ||
            declarator.id.name !== 'handler' ||
            !declarator.init
          ) continue;

          const init = declarator.init;
          const isWrapped =
            init.type === 'CallExpression' &&
            init.callee.type === 'Identifier' &&
            init.callee.name === 'withClientIsolation';

          if (!isWrapped) {
            context.report({ node: declarator, messageId: 'missingWrapper' });
          }
        }
      },
    };
  },
};
