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
