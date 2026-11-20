// simHost.js — the main thread's handle on the simulation: a module worker when one can
// start, otherwise the same runtime inline (loudly, so `__poeco().mode` shows it).
import { createSimRuntime } from './simRuntime.js';
import { openWorldStore } from '../sim/persistence/idb.js';
import { BOOT_DEADLINE_MS, RAPIER_DEADLINE_MS, loadRapier, withDeadline } from './deadline.js';

// How long the worker may stay silent after being asked for a world before the main
// thread stops believing in it. A worker that fails outright raises onerror in
// milliseconds; this is for the one that starts, imports something that never answers,
// and simply never speaks — see deadline.js.
const READY_DEADLINE_MS = 15000;

export async function createSimHost({ onMessage, WorkerCtor = globalThis.Worker, workerUrl = null, importCannon = null, importRapier = null, idb = null, log = null } = {}) {
  const say = (m) => { if (log) log(m); };

  async function inline() {
    let CANNON = null;
    // Bare-specifier or not, this resolves to the same CDN the worker uses, so it gets the
    // same clock: the fallback path must not inherit the hang it exists to rescue.
    try {
      CANNON = importCannon
        ? await withDeadline(importCannon(), BOOT_DEADLINE_MS, () => { say('cannon-es did not load in time inline — running without physics'); return null; })
        : null;
    } catch (err) { say(`cannon-es unavailable inline: ${err?.message ?? err}`); }
    const store = idb ?? await openWorldStore();
    const RAPIER = importRapier ? await withDeadline(loadRapier(importRapier), RAPIER_DEADLINE_MS, () => null) : null;
    const runtime = createSimRuntime((msg) => queueMicrotask(() => onMessage(msg)), { physicsLib: RAPIER ?? CANNON, idb: store });
    say('PoEcosystem sim running INLINE on the main thread (worker unavailable)');
    return { mode: 'inline', runtime, send: (msg) => runtime.handle(msg), dispose: () => runtime.dispose() };
  }

  if (typeof WorkerCtor !== 'function') return inline();
  let worker;
  try {
    worker = new WorkerCtor(workerUrl ?? new URL('./simWorker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    say(`sim worker failed to start: ${err?.message ?? err}`);
    return inline();
  }

  const sent = [];      // replayed if the worker dies before it is ready
  let ready = false;
  // The last message that asked for a world. A worker that dies AFTER ready used to be
  // left for dead — giveUpOnWorker only rescues one that never started — and the island
  // froze on its last frame. Now the same world is resumed inline from its last autosave
  // (HOST.autosaveSeconds old at most), which is the best copy of it there is.
  let lastWorldAsk = null;
  let recovering = false;
  let fallback = null;
  let readyTimer = null;

  // Everything the page draws arrives after the worker's first `ready`, so a worker that
  // never gets there is indistinguishable from a frozen game. Rescue it the same way a
  // crashed one is rescued: re-run the whole conversation inline.
  const giveUpOnWorker = async (why) => {
    readyTimer = null;
    if (ready || fallback) return;
    say(`sim worker ${why} — replaying on the main thread`);
    try { worker.terminate(); } catch { /* already gone */ }
    fallback = await inline();
    host.mode = 'inline';
    for (const msg of sent) fallback.send(msg);
  };

  const host = {
    mode: 'worker',
    worker,
    send(msg, transfer) {
      if (msg.type === 'init' || msg.type === 'newWorld') lastWorldAsk = msg;
      if (fallback) { fallback.send(msg); return; }
      if (!ready && msg.type !== 'recycle') {
        sent.push(msg);
        // Start the clock on the first message that asks for a world, not on construction:
        // a host built long before the page boots is not yet late.
        if (readyTimer === null && (msg.type === 'init' || msg.type === 'newWorld')) {
          readyTimer = setTimeout(() => giveUpOnWorker(`stayed silent for ${READY_DEADLINE_MS} ms`), READY_DEADLINE_MS);
        }
      }
      worker.postMessage(msg, transfer ?? []);
    },
    dispose() {
      if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
      if (fallback) fallback.dispose();
      else { try { worker.postMessage({ type: 'dispose' }); } catch { /* gone */ } worker.terminate(); }
    },
  };
  worker.onmessage = (e) => {
    if (e.data?.type === 'ready') {
      ready = true;
      if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
    }
    onMessage(e.data);
  };
  const recoverAfterCrash = async (why) => {
    if (fallback || recovering) return;
    recovering = true;
    say(`sim worker crashed after start (${why}) — resuming the last autosave on the main thread`);
    onMessage({ type: 'error', where: 'worker-crash', message: why });
    try { worker.terminate(); } catch { /* already gone */ }
    fallback = await inline();
    host.mode = 'inline';
    fallback.send({ ...(lastWorldAsk ?? { seed: 0 }), type: 'init', resume: true });
  };
  worker.onerror = (err) => {
    say(`sim worker error: ${err?.message ?? err}`);
    if (readyTimer !== null) { clearTimeout(readyTimer); readyTimer = null; }
    if (ready) return recoverAfterCrash(String(err?.message ?? err));
    return giveUpOnWorker(`error: ${err?.message ?? err}`);
  };
  return host;
}
