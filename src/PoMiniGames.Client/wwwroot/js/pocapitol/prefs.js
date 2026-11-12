/**
 * PoCapitol's own player-comfort preferences and key map.
 *
 * Reduced motion, reduced flashing, the colour-safe palette and the volume buses are
 * app-wide and already live on <html> or in the shared audio bus (appPrefs.js). This module
 * holds only what is specific to this game: how fast the view turns, how wide the lens is,
 * whether spoken radio is captioned, HUD contrast, radar palette, tracer style, combat shake,
 * the phone-footage look and sound, and the key map itself.
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
    tracers: 'luminous', motion: 'full', footage: 'light', debrief: 'rules', debriefModel: 'llama3.2',
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
        tracers: oneOf(value.tracers, ['luminous', 'stealth', 'off'], DEFAULTS.tracers),
        motion: oneOf(value.motion, ['full', 'reduced'], DEFAULTS.motion),
        // How much of the picture is a phone in the crowd: all of it (with the phone's microphone
        // on the sound as well), a trace of it on the picture only, or none.
        footage: oneOf(value.footage, ['on', 'light', 'off'], DEFAULTS.footage),
        // Who writes the after-action debrief: the built-in writer, or a model on this machine.
        debrief: oneOf(value.debrief, ['rules', 'ollama'], DEFAULTS.debrief),
        debriefModel: typeof value.debriefModel === 'string' && /^[\w.:\/-]{1,60}$/.test(value.debriefModel)
            ? value.debriefModel : DEFAULTS.debriefModel,
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

/**
 * Bind `code` to `action`. A key can only do one thing: if another action already holds it, the
 * two swap, so a remap can never leave one key firing two actions or an action with no key.
 */
export function rebind(prefs, action, code) {
    const keys = { ...prefs.keys };
    if (!(action in keys) || !isCode(code) || keys[action] === code) return prefs;
    const holder = Object.keys(keys).find(other => other !== action && keys[other] === code);
    if (holder) keys[holder] = keys[action];
    keys[action] = code;
    return { ...prefs, keys };
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
