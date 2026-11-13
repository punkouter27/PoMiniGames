// pocabinet/index.js
//
// Facade module. Blazor's IJSRuntime can only invoke functions reachable from
// `window`, so the engine's named ES exports are re-exported under a single
// `window.PoCabinet` namespace (the same JS.InvokeAsync dance as the other
// engines); the modules themselves stay directly importable.
//
// Contract surface (called from src/PoMiniGames.Client/Games/PoCabinet/...):
//   PoCabinet.mount(canvasId, world) -> sceneHandle      — world = PoCabinetStaticWorld
//   PoCabinet.unmount(handle)
//   PoCabinet.mountDialogue(parentId) / showDialogue(handle, name, text) / unmountDialogue
//   PoCabinet.mountMinimap(canvasId, world, opts) / unmountMinimap(handle)
//   PoCabinet.mountEnvironment(sceneHandle, weather) / unmountEnvironment(handle)
//
//   PoCabinet.startRace(dotnetRef, scene, minimap, opts)  — race.js driver
//   PoCabinet.stopRace() / pauseRace() / resumeRace()      — each also suspends/resumes the audio
//                                                          (startRace un-suspends: a restart follows a stopRace)
//   PoCabinet.pushServerSnapshot(snap)                     — multiplayer
//   PoCabinet.cycleCamera()
//   PoCabinet.showTelemetry(canvasId) -> summary text
//   PoCabinet.startReplay() / replayCommand(cmd, value) / stopReplay()
//   PoCabinet.recordClip() -> 'shared' | 'downloaded' | 'unavailable'
//   PoCabinet.lapProof() -> { inputs, wet }               — solo score verification
//   PoCabinet.setBanter(lines)                             — officials' radio (scripted pool; text only)
//
//   PoCabinet.applySettings(scene, settings)               — settings are Blazor's (PoCabinetUiSettings)
//   PoCabinet.getRecords(trackId) / recordTrackResult(trackId, bestLap, sectors)
//   PoCabinet.initAudio() / countdownBeep / blip / lapChime / fanfare
//   PoCabinet.showModal(id)                                — pause dialog (focus trap, inert page)

import { mount as sceneMount, unmount as sceneUnmount } from './scene.js';
import { mount as mountDialogue, unmount as unmountDialogue, show } from './dialogue.js';
import { clearTrackWear } from './fx.js';
import { setComputeMode, getGpuStats } from './gpucompute.js';
import { mountUiShader, unmountUiShader, setUiShaderMode, pulseUiShader } from './uishader.js';
import {
    startRace, stopRace, pauseRace, resumeRace, pushServerSnapshot, updateRaceSettings, cycleCamera,
    showTelemetry, startReplay, replayCommand, stopReplay, recordClip, lapProof, setBanter,
} from './race.js';
import { getRecords, recordTrackResult } from './records.js';
import * as audio from './audio.js';
import { mountMinimap, unmountMinimap } from './minimap.js';
import { mountEnvironment, unmountEnvironment } from './environment.js';

const api = {
    mount: sceneMount,
    unmount: sceneUnmount,
    mountDialogue,
    /** One line from an official: names the speaker, shows the bubble, plays the radio blip. */
    showDialogue(handle, name, text) {
        show(handle, name, text);
        audio.blip();
    },
    unmountDialogue,

    /** Every race starts audible: Restart, Race again, Next stage and the online rematch all
     *  follow a stopRace (which suspended the audio) without another Start click. */
    startRace(dotnetRef, sceneHandle, minimapHandle, opts) {
        setComputeMode(opts?.settings?.gpuCompute || 'auto');
        const r = startRace(dotnetRef, sceneHandle, minimapHandle, opts);
        audio.setSuspended(false);
        return r;
    },
    stopRace() {
        stopRace();
        audio.setSuspended(true);
    },
    pauseRace() {
        pauseRace();
        audio.setSuspended(true);
    },
    resumeRace() {
        resumeRace();
        audio.setSuspended(false);
    },
    pushServerSnapshot,
    cycleCamera,
    showTelemetry,
    startReplay,
    replayCommand,
    stopReplay,
    recordClip,
    lapProof,
    setBanter,

    getRecords,
    recordTrackResult,

    /** The Start click: create or resume the AudioContext (it needs a user gesture). */
    initAudio() {
        audio.init();
        audio.setSuspended(false);
    },
    countdownBeep: audio.countdownBeep,
    lapChime: audio.lapChime,
    fanfare: audio.fanfare,

    mountMinimap,
    unmountMinimap,

    /**
     * Open a rendered <dialog> as modal. Its own Esc-close is cancelled: Esc is input.js's
     * pause toggle, and letting both act would close the dialog without resuming the race.
     */
    showModal(id) {
        const d = document.getElementById(id);
        if (!d || d.open || typeof d.showModal !== 'function') return;
        d.addEventListener('cancel', e => e.preventDefault());
        d.showModal();
    },

    mountEnvironment,
    unmountEnvironment,
    mountUiShader,
    unmountUiShader,
    pulseUiShader,
    clearTrackWear,
    getGpuStats,

    /** Push the player's settings into the live scene, audio graph and race driver. */
    applySettings(sceneHandle, settings) {
        if (sceneHandle && !sceneHandle.disposed) {
            sceneHandle.applyView(settings);
            // "Room scans": auto, the full splat or the lite mesh (PoCabinetUiSettings.RoomDetail).
            if (settings?.roomDetail) sceneHandle.setRoomDetail(settings.roomDetail);
        }
        setComputeMode(settings?.gpuCompute || 'auto');
        setUiShaderMode(settings?.gpuCompute || 'auto');
        audio.setMusicEnabled(settings?.music !== false);
        updateRaceSettings(settings);
    },
};

window.PoCabinet = api;

// Entry paths with no Start click (the self-starting demo, a guest landing in a
// multiplayer race) still unlock the AudioContext on the player's first gesture.
const unlockAudio = () => {
    audio.init();
    window.removeEventListener('pointerdown', unlockAudio);
    window.removeEventListener('keydown', unlockAudio);
};
window.addEventListener('pointerdown', unlockAudio);
window.addEventListener('keydown', unlockAudio);

// The race view is sized to the screen under the app's top bar, whose height depends on what it
// holds (and is 0 when games.css hides it on a sideways phone): publish the measured height.
const topBar = document.querySelector('.gl-top-bar');
if (topBar && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
        document.documentElement.style.setProperty('--pocabinet-topbar-h', `${topBar.getBoundingClientRect().height}px`);
    }).observe(topBar);
}

// A hidden tab is silent: the frame loop stops with the tab, but the engine, beds and music
// would hold their last notes (race.js pauses a solo race on the same event).
document.addEventListener('visibilitychange', () => audio.setHidden(document.hidden));
