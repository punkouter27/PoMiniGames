// bootPrefs.js — render-blocking preference bootstrap (moved out of inline <script> in index.html
// so CSP script-src does not need 'unsafe-inline').
(function () {
    try {
        if (localStorage.getItem('pominigames:reduced-motion') === '1'
            || matchMedia('(prefers-reduced-motion: reduce)').matches) {
            document.documentElement.setAttribute('data-motion', 'reduce');
        }
        if (localStorage.getItem('pominigames:color-safe') === '1') {
            document.documentElement.setAttribute('data-colorsafe', '1');
        }
    } catch (e) {
        // Private mode / storage disabled: the defaults stand.
    }
})();
