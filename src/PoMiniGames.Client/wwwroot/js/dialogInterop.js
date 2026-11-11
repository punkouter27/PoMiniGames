// PoDialogInterop — minimal <dialog> helpers for Blazor interop (Option #9).
//
// Loaded as a classic module from index.html before Blazor boots. Both
// functions are no-ops if the referenced element is not a <dialog>, which
// keeps the call sites safe in prerender / disconnected states.
//
// Why a shim instead of calling dialog.showModal() / dialog.close() directly
// from C#? Blazor's ElementReference interop only binds a fixed set of
// methods (focus, click, etc.) — showModal and close are HTMLDialogElement
// instance methods, not on the standard element surface. Going through JS is
// the supported path.
window.PoDialogInterop = (function () {
    function showModal(el) {
        if (!el || el.tagName !== 'DIALOG' || el.open) return;
        if (!el.__poTabTrap) {
            el.__poTabTrap = true;
            el.addEventListener('keydown', function (event) {
                if (event.key !== 'Tab' || !el.matches(':modal')) return;
                var controls = Array.from(el.querySelectorAll('button, a[href], input, select, textarea, summary, [tabindex]'))
                    .filter(function (control) {
                        return !control.disabled && control.tabIndex >= 0 &&
                            control.getClientRects().length > 0 &&
                            !control.closest('[inert], [hidden]') &&
                            getComputedStyle(control).visibility !== 'hidden';
                    });
                var index = controls.indexOf(document.activeElement);
                if (!controls.length || index < 0 ||
                    (!event.shiftKey && index === controls.length - 1) ||
                    (event.shiftKey && index === 0)) {
                    event.preventDefault();
                    (event.shiftKey ? controls.at(-1) || el : controls[0] || el).focus();
                }
            });
        }
        try { el.showModal(); } catch (_) { /* already open or detached */ }
    }

    function close(el) {
        if (!el || el.tagName !== 'DIALOG' || !el.open) return;
        try { el.close(); } catch (_) { /* already closed */ }
    }

    // One modal layer at a time. A sheet opened from inside another modal (PoCabinet's
    // pause dialog, PoEcosystem's dashboard) would otherwise stack a second backdrop on
    // the first. The layers under it are put away while it is up and come back when it
    // closes: a <dialog> is closed and re-opened modal (its own backdrop goes with it),
    // an aria-modal overlay is hidden in place.
    function isModalLayer(other) {
        if (other.tagName === 'DIALOG') {
            try { return other.matches(':modal'); } catch (_) { return other.open; }
        }
        return other.getClientRects().length > 0 && getComputedStyle(other).visibility !== 'hidden';
    }

    function showModalAlone(el) {
        if (!el || el.tagName !== 'DIALOG' || el.open) return;
        var opener = document.activeElement;
        var stashed = [];
        document.querySelectorAll('dialog[open], [aria-modal="true"]').forEach(function (other) {
            if (other === el || el.contains(other) || other.contains(el) || !isModalLayer(other)) return;
            if (other.tagName === 'DIALOG') {
                close(other);
                stashed.push({ el: other, dialog: true });
            } else {
                stashed.push({ el: other, dialog: false, visibility: other.style.visibility });
                other.style.visibility = 'hidden';
            }
        });
        if (stashed.length) {
            el.addEventListener('close', function () {
                stashed.forEach(function (s) {
                    if (!s.el.isConnected) return;
                    if (s.dialog) showModal(s.el);
                    else s.el.style.visibility = s.visibility;
                });
                // The browser hands focus back before this runs, while the opener's layer
                // was still put away, so it usually lands on <body>. Hand it over again.
                var a = document.activeElement;
                if (opener && opener.isConnected && (!a || a === document.body)) {
                    try { opener.focus({ preventScroll: true }); } catch (_) { /* gone */ }
                }
            }, { once: true });
        }
        showModal(el);
    }

    // Escape fires `cancel`, which closes the dialog by default. A dialog that must stay up
    // until the page is done with it (PoMule's standings) keeps its own @oncancel handler
    // and calls this once. Razor has no `:preventDefault` modifier for `cancel`: written in
    // markup it renders as a literal attribute, which older Chromium refuses outright.
    function holdOpen(el) {
        if (!el || el.tagName !== 'DIALOG' || el.__poHoldOpen) return;
        el.__poHoldOpen = true;
        el.addEventListener('cancel', function (e) { e.preventDefault(); });
    }

    return { showModal: showModal, showModalAlone: showModalAlone, close: close, holdOpen: holdOpen };
})();
