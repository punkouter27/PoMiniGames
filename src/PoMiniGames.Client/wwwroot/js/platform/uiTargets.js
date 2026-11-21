// uiTargets.js — which controls count as "real buttons/cards" for the delegated
// press spring (springUi.js) and the delegated press cue (uiAudio.js).
//
// WHY ONE LIST: both behaviours used to be opt-in per element (data-spring), so only the
// ~6 files someone remembered to edit had them and the rest of the app felt dead next to
// them. Naming the shared component classes here gives every .app-btn, segmented button,
// bottom-nav item, catalog card head/chip, intro tab and Radzen button the same feel
// without touching 40 razor files. A control still opts OUT with data-spring="off"
// (springUi) or data-no-press-sound (uiAudio); data-spring="0.9" still tunes the scale.
//
// Games keep their own canvases and HUD: only DOM controls match, and nothing here
// matches inside a <canvas> host.

export const KNOWN_SELECTOR = [
    '.app-btn', '.app-seg__btn', '.app-bottom-nav__item',
    '.home-card-head', '.home-mode-chip', '.home-action',
    '.gps-intro-tab', '.gps-ceremony-skip',
    '.lb-me-chip', '.lb-search__toggle', '.po-header__settings',
    '.rz-button', '[role="tab"]', '[role="radio"]',
    '.gps-modal button',
].join(',');

/** Known shared controls plus anything that opted in by hand. */
export const PRESS_SELECTOR = `${KNOWN_SELECTOR},[data-spring],[data-magnetic]`;

/**
 * The control an event target belongs to, or null (disabled, or opted out).
 * @param {EventTarget|null} target
 * @param {string} [optOutAttr]
 */
export function pressTarget(target, optOutAttr) {
    const el = target && target.closest ? target.closest(PRESS_SELECTOR) : null;
    if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
    if (optOutAttr && el.closest(`[${optOutAttr}]`) && !el.closest(`[${optOutAttr}="on"]`)) return null;
    return el;
}
