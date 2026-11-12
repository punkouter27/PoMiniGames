# PoMiniGames Game Consistency

Applies only to PoMiniGames repos. Reuse shared services and components while preserving distinct
game mechanics and art direction.

1. **Modes & Entry:** Classify modes (1 player, 2 player, Online, DEMO) and document exceptions.
   Standard entry uses `GameIntro`; only kiosk flow (`?kiosk=N`) skips it. Select mode on hub.
2. **Lifecycle:** Sequence intro/setup -> loading (if needed) -> active play -> results/pause. Lock
   input/result processing post-run. Specify if online play continues while paused. Offer retry
   only for retryable failures; never present a failed operation as success.
3. **Shared Surfaces:** `GameShell` manages title/settings/diagnostics/results; `GameIntro` handles
   setup; `GameOverModal` handles main menu exits. Retain shared dialog geometry.
4. **State Vocabulary:** Use `GameSkeleton`/`GameShell Loading` for loads, `ErrorState` for page
   failures, `InlineError` for card failures, and `EmptyState` for empty data. No browser alerts.
5. **Results & Recording:** Record terminal outcomes once via `GameResultService` (await
   local/high-score paths). Guard against duplicate callbacks and rely on offline queues for
   failures. Continuous sandboxes (e.g. PoEcosystem) get no invented end states or results.
6. **HUD & Layout:** Position HUD strips via `HudRegion` and standard tokens. Keep HUD clear of
   dialogs and safe areas.
7. **Controls & Inputs:** Align intro instructions with actual controls. Share gamepad paths and
   focus handling across keyboard, touch, pointer, and gamepad without replacing primary paths.
8. **Mobile Requirements:** Support phone/laptop viewports, respect safe areas, prevent page
   scrolling, and enforce ≥44x44px touch targets on coarse pointers.
9. **A11y & Prefs:** Meet WCAG 2.2 AA contrast (4.5:1 normal, 3:1 large), visible focus,
   assistive tech updates, and reduced motion. Route sound to the shared audio bus.
10. **Diagnostics & Verification:** Toggle diagnostics with Tab during play; Escape closes panels.
    Preserve specialized panels and run game-debug/LinkAudit verification checks.

## Documented exceptions

- **PoEcosystem:** DEMO only and observation-only. It records no result (continuous sandbox),
  keeps its own Tab world dashboard (`TabDebug` off), and keeps its own `AudioContext` because
  its sounds are positioned in 3D world space; it follows the app-wide mute and volume.
- **PoJevArena:** DEMO only. Keeps its own stats sheet (`TabDebug` off). Match outcomes are
  creature records posted to the server, not a player win/loss.
- **PoCabinet:** keeps its own `AudioContext` for the 3D listener; it follows the app-wide mute
  and volume.
- **SandPlayground:** sandbox with no results (challenge bests stay local) and pointer/touch
  only; there is no gamepad path for a painting tool.
- **PoFighter:** preview with one mode, a 1 player practice room. It is a sandbox with no end
  state and records no result. Its HUD is static markup the engine writes into (no per-tick
  Blazor render, so no `HudRegion`), and it has no sound yet.
- **PoBrawl FFA:** seasons and ratings are local to the browser (`ffaSeason.js`) and do not go
  through `GameResultService`.
- **ConnectFive:** nine columns cannot be 44px wide on a phone. The touch target is the whole
  column (any tap in it drops a piece), so each target is full board height and ~36–40px wide.
- **PoCoupleQuiz:** Online only.
