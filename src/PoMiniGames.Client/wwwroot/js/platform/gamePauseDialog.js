const traps = new WeakMap();
const selector = 'button, a[href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';

export function attach(root, reference) {
    if (!root || traps.has(root)) return;
    const opener = document.activeElement;
    const visible = element => element.getClientRects().length > 0 &&
        !element.closest('[inert], [hidden]') && getComputedStyle(element).visibility !== 'hidden';
    const controls = () => [...root.querySelectorAll(selector)]
        .filter(element => !element.disabled && element.tabIndex >= 0 && visible(element));
    // A settings drawer can temporarily own focus above the pause surface.
    const active = () => root.isConnected && visible(root) &&
        ![...document.querySelectorAll('dialog[open], [aria-modal="true"]')]
            .some(other => other !== root && !other.contains(root) && !root.contains(other) && visible(other));
    const focusFirst = () => (controls()[0] || root).focus({ preventScroll: true });
    const keydown = event => {
        if (event.key === 'Escape' && reference && active()) {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!event.repeat) reference.invokeMethodAsync('ResumeAsync')
                .catch(error => console.error('Unable to resume the paused game.', error));
            return;
        }
        // P and controller pause retain each engine's existing semantics.
        if (event.key !== 'Tab' || !active()) return;
        const items = controls();
        const index = items.indexOf(document.activeElement);
        if (!items.length || index < 0 || (!event.shiftKey && index === items.length - 1) ||
            (event.shiftKey && index === 0)) {
            event.preventDefault();
            (event.shiftKey ? items.at(-1) || root : items[0] || root).focus({ preventScroll: true });
        }
    };
    const focusin = event => {
        if (active() && !root.contains(event.target)) focusFirst();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    traps.set(root, { opener, keydown, focusin });
    if (!root.contains(document.activeElement)) focusFirst();
}

export function detach(root) {
    const trap = traps.get(root);
    if (!trap) return;
    document.removeEventListener('keydown', trap.keydown, true);
    document.removeEventListener('focusin', trap.focusin);
    traps.delete(root);
    if (trap.opener?.isConnected && !document.querySelector('dialog[open]')) {
        trap.opener.focus({ preventScroll: true });
    }
}
