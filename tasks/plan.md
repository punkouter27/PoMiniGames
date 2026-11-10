# PoCapitol implementation plan

The owner requested implementation after the product draft. Adopt its explicit working
defaults; preserve all existing games. No new dependencies, services, secrets, or public scores.

| Slice | Files (at most five) | Acceptance | Verification | Blast radius |
|---|---|---|---|---|
| Rules | `world.js`, `pocapitol-world.test.mjs` | Ordered journey; collision, combat, pause, restart and exclusive outcomes | Focused Node tests, red before implementation | New game only |
| Presentation | `scene.js`, `index.js` | Recognizable stylized motifs, working input, cleaned-up rendering | Syntax checks and browser play | New game and reused shared buses |
| Discovery | Domain/client `GameKey.cs`, `GameCatalog.cs`, `engineLoader.js` | Hub card and lazy-loaded route; known play-session key | Host build and browser navigation | Existing catalog gains one entry |
| Player interface | `PoCapitolPage.razor`, its stylesheet | Content notice, Radzen setup, HUD, pause, local result and retry | Host build, CSS gate and browser workflows | New page only |
| Documentation | `CAPABILITY-MAP.md`, `SPEC.md`, `README.md`, PRD | Product/technical boundaries agree and original PoMule spec remains | Diff review | Documentation only |
| Evidence | Screenshot comparison HTML/PNG, `tasks/todo.md` | Before/after evidence and truthful completion status | Inspect generated artifacts | Documentation only |

No actual access routes or security-sensitive building details are modeled.
Photorealism, public rankings, multiplayer, and a spectator demo are excluded.
