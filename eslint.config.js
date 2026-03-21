const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier');

module.exports = [
    {
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 2015,
            globals: {
                ...globals.browser
            }
        },
        rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'off'
        }
    },
    {
        files: ['server/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.node
            }
        },
        rules: {
            'no-undef': 'warn'
        }
    },
    prettier
];
