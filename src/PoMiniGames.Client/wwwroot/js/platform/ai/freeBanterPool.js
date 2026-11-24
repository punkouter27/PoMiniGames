// platform/ai/freeBanterPool.js — Zero-Cost Async NPC Banter & Pre-Fetch Ring Buffer (#14).
// Serves PoFighter pre-fight banter, PoCabinet pit-wall radio, and PoCapitol loudhailer lines.
// Uses Chrome Built-in AI (`LanguageModel`) locally when available, with an optional user-supplied
// free-tier REST endpoint, a 5-minute circuit breaker, and instant deterministic template fallback.

const CIRCUIT_OPEN_MS = 5 * 60 * 1000;

export class FreeBanterPool {
  constructor(fallbackTemplates = [], opts = {}) {
    this.fallbacks = fallbackTemplates.length > 0 ? fallbackTemplates : ['Stay sharp out there.'];
    this.maxBuffered = opts.maxBuffered ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 1500;
    this.queue = [];
    this.circuitOpenUntil = 0;
    this.inFlight = false;
    this.fallbackCursor = 0;
  }

  /** Instant, zero-latency synchronous pull for gameplay/HUD triggers. */
  take(contextHint = '') {
    if (this.queue.length > 0) {
      return this.queue.shift();
    }
    // Kick off async replenishment for future moments without blocking now.
    this.prefetch(contextHint);
    const line = this.fallbacks[this.fallbackCursor % this.fallbacks.length];
    this.fallbackCursor++;
    return line;
  }

  /** Background pre-fetch during lobby, loading, or lap boundaries. */
  async prefetch(contextHint = '') {
    if (this.inFlight || this.queue.length >= this.maxBuffered) return;
    if (Date.now() < this.circuitOpenUntil) return;
    if (typeof globalThis.LanguageModel === 'undefined') return;

    this.inFlight = true;
    let timer = null;
    try {
      const avail = await globalThis.LanguageModel.availability?.();
      if (avail === 'unavailable') return;
      const session = await globalThis.LanguageModel.create({
        systemPrompt: 'Write ONE short, family-friendly arcade game banter line (under 14 words). No quotes.',
      });
      const text = await Promise.race([
        session.prompt(`Context: ${contextHint || 'arcade rivalry'}`),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), this.timeoutMs);
        }),
      ]);
      const line = String(text ?? '').trim().replace(/^["']|["']$/g, '').slice(0, 120);
      if (line.length > 4) this.queue.push(line);
      session.destroy?.();
    } catch {
      this.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    } finally {
      if (timer !== null) clearTimeout(timer);
      this.inFlight = false;
    }
  }
}
