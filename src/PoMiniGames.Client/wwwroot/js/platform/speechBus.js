// speechBus.js — shared Web Speech API announcer (SpeechSynthesis) and hands-free trivia
// voice input (SpeechRecognition). Zero external cost, zero server calls.
//
// Voice announcer is opt-in (`pominigames:voice-announcer`, off by default) and respects
// the app-wide mute flag (`pominigames:muted`). Never queues stale lines: a new call
// cancels any pending utterance so race/fight callouts stay timely.

const VOICE_KEY = 'pominigames:voice-announcer';
const MUTE_KEY = 'pominigames:muted';

let _enabled = readEnabled();
let _recognition = null;
let _listening = false;

function readEnabled() {
    try {
        return localStorage.getItem(VOICE_KEY) === '1';
    } catch {
        return false;
    }
}

function isMuted() {
    try {
        return (localStorage.getItem(MUTE_KEY) || '').includes('1');
    } catch {
        return false;
    }
}

export function isSupported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance === 'function';
}

export function isRecognitionSupported() {
    return typeof window !== 'undefined' && !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export function isEnabled() {
    return _enabled;
}

export function setEnabled(on) {
    _enabled = !!on;
    try {
        localStorage.setItem(VOICE_KEY, _enabled ? '1' : '0');
    } catch { /* private mode */ }
    if (!_enabled) stopSpeaking();
}

export function stopSpeaking() {
    if (!isSupported()) return;
    try { window.speechSynthesis.cancel(); } catch { /* ignore */ }
}

/**
 * Speak a short line if Voice Announcer is enabled and the app is not muted.
 * @param {string} text
 * @param {{ rate?: number, pitch?: number, force?: boolean, interrupt?: boolean }} [opts]
 */
export function speak(text, opts = {}) {
    if (!text || !isSupported() || isMuted()) return false;
    if (!opts.force && !_enabled) return false;
    try {
        if (opts.interrupt !== false) window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(String(text));
        u.rate = typeof opts.rate === 'number' ? Math.max(0.6, Math.min(1.6, opts.rate)) : 1.05;
        u.pitch = typeof opts.pitch === 'number' ? Math.max(0.5, Math.min(1.5, opts.pitch)) : 1.0;
        u.volume = 0.85;
        window.speechSynthesis.speak(u);
        return true;
    } catch {
        return false;
    }
}

/**
 * Read a trivia question and its numbered options when Voice Announcer is enabled.
 * @param {string} question
 * @param {string[]} options
 */
export function speakQuestion(question, options) {
    if (!_enabled || !question) return false;
    const parts = [question];
    if (Array.isArray(options)) {
        for (let i = 0; i < options.length; i++) {
            parts.push(`Option ${i + 1}: ${options[i]}`);
        }
    }
    return speak(parts.join('. '), { rate: 1.02, interrupt: true });
}

/**
 * Parse a spoken trivia transcript into a 0-based option index, or -1 if unmatched.
 * @param {string} transcript
 * @param {string[]} [options]
 */
export function matchSpokenOption(transcript, options = []) {
    const raw = String(transcript || '').trim().toLowerCase();
    if (!raw) return -1;

    const clean = raw.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = clean.split(' ');
    const last = tokens[tokens.length - 1] || '';

    const map = {
        '1': 0, 'one': 0, 'first': 0, 'a': 0, 'alpha': 0, 'option 1': 0, 'option a': 0, 'number 1': 0,
        '2': 1, 'two': 1, 'to': 1, 'too': 1, 'second': 1, 'b': 1, 'bravo': 1, 'option 2': 1, 'option b': 1, 'number 2': 1,
        '3': 2, 'three': 2, 'tree': 2, 'third': 2, 'c': 2, 'charlie': 2, 'option 3': 2, 'option c': 2, 'number 3': 2,
        '4': 3, 'four': 3, 'for': 3, 'fourth': 3, 'd': 3, 'delta': 3, 'option 4': 3, 'option d': 3, 'number 4': 3,
    };

    if (clean in map) return map[clean];
    if (last in map) return map[last];

    if (Array.isArray(options)) {
        for (let i = 0; i < options.length; i++) {
            const opt = String(options[i] || '').trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            if (opt && (clean === opt || (opt.length >= 3 && clean.includes(opt)))) return i;
        }
    }
    return -1;
}

/**
 * Start listening for hands-free trivia answers via Web SpeechRecognition.
 * Invokes `methodName(transcript)` on `dotnetRef`.
 */
export function startListening(dotnetRef, methodName = 'OnVoiceTranscriptAsync') {
    if (!isRecognitionSupported()) return false;
    stopListening();
    try {
        const Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
        const r = new Rec();
        r.lang = 'en-US';
        r.continuous = true;
        r.interimResults = false;
        r.maxAlternatives = 3;
        r.onresult = (ev) => {
            for (let i = ev.resultIndex; i < ev.results.length; i++) {
                const res = ev.results[i];
                if (!res.isFinal) continue;
                for (let alt = 0; alt < res.length; alt++) {
                    const text = res[alt]?.transcript?.trim();
                    if (text) {
                        dotnetRef?.invokeMethodAsync?.(methodName, text).catch(() => {});
                    }
                }
            }
        };
        r.onerror = () => {
            _listening = false;
        };
        r.onend = () => {
            // Auto-restart while active so hands-free mode persists across questions.
            if (_listening && _recognition === r) {
                try { r.start(); } catch { _listening = false; }
            }
        };
        _recognition = r;
        _listening = true;
        r.start();
        return true;
    } catch {
        _listening = false;
        _recognition = null;
        return false;
    }
}

export function stopListening() {
    _listening = false;
    if (_recognition) {
        const r = _recognition;
        _recognition = null;
        try { r.onend = null; r.stop(); } catch { /* ignore */ }
    }
}

if (typeof window !== 'undefined') {
    window.addEventListener('po-audio-change', () => {
        if (isMuted()) stopSpeaking();
    });
    window.PoSpeech = {
        isSupported,
        isRecognitionSupported,
        isEnabled,
        setEnabled,
        speak,
        speakQuestion,
        stopSpeaking,
        matchSpokenOption,
        startListening,
        stopListening,
    };
}
