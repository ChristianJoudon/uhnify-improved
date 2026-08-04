module.exports = {
  env: {
    browser: true,
    es2021: true,
    node: true,
  },
  extends: [
    'plugin:react/recommended',
    'plugin:meteor/recommended',
    'airbnb',
  ],
  parserOptions: {
    ecmaFeatures: {
      jsx: true,
    },
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  plugins: [
    'jsx',
    'meteor',
    'react',
  ],
  globals: {
    /* Meteor 2.x exposes this as a server global rather than as an importable
       package — `import { Assets } from 'meteor/assets'` does not exist — so
       without declaring it here the seed loader reads as an undefined variable
       and fails the build on a line that is entirely correct. */
    Assets: 'readonly',
  },
  rules: {
    'arrow-parens': 'off',
    camelcase: 'off',
    'class-methods-use-this': 'off',
    'func-names': 'off',
    'import/no-absolute-path': 'off',
    'import/no-unresolved': 'off',
    'import/extensions': 'off',
    'import/imports-first': 'off',
    'import/prefer-default-export': 'off',
    'import/no-extraneous-dependencies': 'off',
    indent: ['error', 2],
    'linebreak-style': 'off',
    'max-len': ['error', 250],
    'meteor/eventmap-params': [2, { eventParamName: 'event', templateInstanceParamName: 'instance' }],
    'meteor/template-names': 'off',
    'no-confusing-arrow': ['error', { allowParens: true }],
    'no-plusplus': 'off',
    'no-underscore-dangle': 'off',
    'object-curly-newline': 'off',
    'object-property-newline': 'off',
    'object-shorthand': 'off',
    'operator-linebreak': 'off',
    'padded-blocks': 'off',
    'prefer-arrow-callback': 'off',
    'prefer-destructuring': 'off',
    'prefer-promise-reject-errors': 'off',
    'react/function-component-definition': [2, { namedComponents: 'arrow-function' }],
    'react/jsx-one-expression-per-line': 'off',
    'react/no-array-index-key': 'off',
    /* airbnb sets this rule's `assert` to 'both', which demands a label BOTH
       carry htmlFor AND wrap its control. The accessibility requirement is
       either one: an explicit htmlFor/id pair is a complete association, and
       every label this flagged has one pointing at a real input — including
       ChipInput's, which puts the id it is given on the <input> it renders.

       'either' is the rule's own default and matches the standard. Nesting the
       controls instead would have satisfied the stricter setting by changing
       the DOM these forms are laid out against, which is a real risk taken to
       satisfy a lint preference rather than to help anybody reading a screen.

       `controlComponents` teaches it that ChipInput IS a control, so a future
       nested usage is understood too. */
    'jsx-a11y/label-has-associated-control': ['error', {
      assert: 'either',
      controlComponents: ['ChipInput'],
      depth: 25,
    }],
  },
};
