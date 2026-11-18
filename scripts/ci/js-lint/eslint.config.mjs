// Only correctness rules that a browser run would otherwise find the hard way: an undefined
// identifier (Voxel Strike's `frameDt` threw on every frame for a day), a duplicate key, an
// unreachable branch. Style is not linted here. Run from this folder: npm ci && npm run lint (it lints from the repo root, the -c base path).
import globals from 'globals';

export default [
    {
        ignores: ['src/PoMiniGames.Client/wwwroot/js/lib/**', '**/*.min.js'],
    },
    {
        files: ['src/PoMiniGames.Client/wwwroot/js/**/*.{js,mjs}'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: { ...globals.browser, ...globals.worker, Blazor: 'readonly', DotNet: 'readonly' },
        },
        linterOptions: { reportUnusedDisableDirectives: 'off' },
        rules: {
            'no-undef': 'error',
            'no-dupe-keys': 'error',
            'no-dupe-class-members': 'error',
            'no-unreachable': 'error',
            'no-self-assign': 'error',
        },
    },
];
