/**
 * PoCapitol's own player-comfort preferences and key map.
 *
 * Reduced motion, reduced flashing, the colour-safe palette and the volume buses are
 * app-wide and already live on <html> or in the shared audio bus (appPrefs.js). This module
 * holds only what is specific to this game: how fast the view turns, how wide the lens is,
 * whether spoken radio is captioned, HUD contrast, radar palette and the key map itself.
 */
const STORE = 'pocapitol.prefs.v1';

export const ACTIONS = [
    { id: 'forward', label: 'Move forward', key: 'KeyW' },
    { id: 'back', label: 'Move back', key: 'KeyS' },
    { id: 'left', label: 'Move left', key: 'KeyA' },
    { id: 'right', label: 'Move right', key: 'KeyD' },
    { id: 'push', label: 'Push', key: 'Space' },
    { id: 'sprint', label: 'Sprint', key: 'ShiftLeft' },
    { id: 'pause', label: 'Pause', key: 'KeyP' },
];

/** Arrow keys always steer, whatever the map says, so a remap can never strand a player. */
const ALWAYS = { forward: ['ArrowUp'], back: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'] };

export const DEFAULTS = Object.freeze({
    sensitivity: 1, fov: 62, captions: false, contrast: 'normal', radar: 'auto', director: true,
});

const clamp = (value, low, high, fallback) =>
    Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;

const oneOf = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;

/** A code is a KeyboardEvent.code we can trust: letters, digits and the named keys we use. */
const isCode = value => typeof value === 'string' && /^[A-Za-z0-9]{1,20}$/.test(value);

/**
 * Coerce anything read from storage into a usable preference set. A corrupt or old record
 * gives the defaults rather than breaking the game, and unknown keys are dropped.
 * @param {unknown} raw
 */
export function sanitizePrefs(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const keys = {};
    const stored = value.keys && typeof value.keys === 'object' ? value.keys : {};
    for (const action of ACTIONS) {
        keys[action.id] = isCode(stored[action.id]) ? stored[action.id] : action.key;
    }
    return {
        sensitivity: Math.round(clamp(value.sensitivity, 0.2, 3, DEFAULTS.sensitivity) * 100) / 100,
        fov: Math.round(clamp(value.fov, 50, 85, DEFAULTS.fov)),
        captions: value.captions === true,
        contrast: oneOf(value.contrast, ['normal', 'high'], DEFAULTS.contrast),
        radar: oneOf(value.radar, ['auto', 'default', 'colorsafe'], DEFAULTS.radar),
        director: value.director !== false,
        keys,
    };
}

export function loadPrefs(storage) {
    try {
        // Resolve localStorage inside the guard: reading the property itself throws on a
        // blocked-storage origin, and a comfort setting must not stop the game from booting.
        const store = storage ?? globalThis.localStorage;
        return sanitizePrefs(JSON.parse(store?.getItem(STORE) ?? 'null'));
    } catch {
        return sanitizePrefs(null);
    }
}

export function savePrefs(prefs, storage) {
    const clean = sanitizePrefs(prefs);
    try { (storage ?? globalThis.localStorage)?.setItem(STORE, JSON.stringify(clean)); } catch { /* private mode: this visit only */ }
    return clean;
}

/** True when `code` is bound to `action`, including the arrows that always steer. */
export function matches(prefs, action, code) {
    if (prefs?.keys?.[action] === code) return true;
    return (ALWAYS[action] ?? []).includes(code);
}

/** A short human label for a KeyboardEvent.code, for the settings rows. */
export function describeCode(code) {
    if (!code) return '—';
    if (code.startsWith('Key')) return code.slice(3);
    if (code.startsWith('Digit')) return code.slice(5);
    if (code.startsWith('Arrow')) return code.slice(5).toUpperCase();
    if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
    if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
    if (code === 'Space') return 'Space';
    if (code === 'Escape') return 'Esc';
    return code;
}
