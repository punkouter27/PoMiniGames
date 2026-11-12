# PoMiniGames Game Consistency Rules

Applies only to games in the PoMiniGames repository. Reuse shared services and
components while preserving each game's mechanics and art direction.

1. **Classify each mode.** Treat a mode as finite, continuous sandbox, demo, or multiplayer, and
   record any exception to the rules below. Every normal game entry uses `GameIntro`; only the
   demo-reel kiosk flow (`?kiosk=N`) skips it. Choose the mode on the hub, not again in the intro.
2. **Define the lifecycle.** Use intro/setup -> loading when preparation is needed -> active play;
   define pause/resume where supported, and transition a true terminal result to results. A
   recoverable failure offers retry or a clear exit. State whether online play continues while a
   pause/options surface is open. Prevent input or result handling after a run has ended.
3. **Use the shared surfaces.** `GameShell` owns the common title, Settings, diagnostics, and
   result surface. Use `GameIntro` for controls/setup and its single OK action; use
   `GameOverModal` for finite results and its common exit to the main menu. Keep optional result
   actions in the shared action/details slots. Preserve shared dialog geometry and styling;
   keep game mechanics, artwork, and HUD presentation game-specific.
4. **Use the shared state vocabulary.** Show `GameSkeleton`/`GameShell Loading` while an engine
   starts, or real progress when available. Use `ErrorState` for a page-level failure,
   `InlineError` when the surrounding card remains usable, and `EmptyState` for a successful
   load with no data. Retry only when the failure is retryable. Never use browser alerts or
   present a failed operation as success.
5. **Record only real results, once.** A result exists only when that mode's rules reach a true
   terminal outcome; continuous simulations do not get invented end states. Route outcomes
   through `GameResultService`, use the appropriate local/stat/high-score path, and await it.
   Guard finish callbacks against duplicate recording. Let the shared service's offline queue
   and player feedback handle retriable submission failures; never invent a rank or saved state.
6. **Keep the HUD legible and non-blocking.** Place HUD strips using the shared `HudRegion`,
   spacing tokens, and position/layer conventions. Keep controls and important information clear
   of gameplay, dialogs, and device safe areas. Retain each game's art direction.
7. **Make controls discoverable and consistent.** The intro's controls and How to play content
   must match the actual bindings. Reuse the shared gamepad path and shared focus/input behavior;
   provide equivalent feedback for supported keyboard, pointer, touch, and gamepad actions.
   Gamepad support must not replace a usable keyboard or pointer path.
8. **Meet mobile interaction requirements.** Respect safe-area insets, prevent unintended page
   scrolling, and keep gameplay usable at phone and laptop viewports. On coarse pointers, provide
   at least 44 x 44 CSS-pixel touch targets (or equivalent target spacing). Allow intentional
   scrolling inside small-screen dialogs without hiding their primary action.
9. **Respect accessibility and global preferences.** Meet WCAG 2.2 AA text contrast (4.5:1 for
   normal text, 3:1 for large text); keep keyboard focus visible, expose meaningful state changes
   to assistive technology, and never rely on color alone. Honor reduced motion and applicable
   palette/audio/haptics preferences. Route game audio through the shared audio bus.
10. **Keep diagnostics predictable and verify the contract.** Tab opens diagnostics only during
    play; Shift+Tab, forms, and dialogs keep normal focus behavior, and Escape closes the panel.
    Keep the visible Stats control for touch. Preserve PoEcosystem/PoJevArena's existing
    specialized panels rather than opening a duplicate generic one. Extend focused checks for
    routes/layout, inputs, state transitions, and one-time result recording; use the existing
    game-debug and LinkAudit checks and respect test-tier ceilings.
