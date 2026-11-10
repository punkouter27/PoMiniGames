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
Photorealism, public rankings and multiplayer are excluded.

## Owner-requested crowd/demo expansion

| Slice | Files (at most five) | Acceptance | Verification | Blast radius |
|---|---|---|---|---|
| Autonomous rules | `world.js`, `pocapitol-world.test.mjs` | Solo 1+99; demo 100 CPU; own milestones/combat; police attack both; deterministic eligible leader; failure/reset | Red population/demo tests followed by focused Node checks | PoCapitol rules |
| Referenced presentation | `scene.js`, `crowd.js` | Instanced crowd and repeated scenery, winter clothes/flags, shields/helmets, public-reference architecture, smooth demo camera and nearby banner occlusion avoidance | Real browser actor/batch counts and exterior/interior captures | PoCapitol graphics |
| Mode integration | `index.js`, page/style, `GameCatalog.cs` | Demo auto-start/loop, spectator HUD, shared switch/reel, no demo stats, cleanup | Lifecycle tests, build, CSS/format and browser | Catalog gains demo; other entries unchanged |
| Documentation | capability map, spec, README, PRD | Confirmed additions and historical limitations agree | Diff review | Documentation |
| Evidence | `tasks/todo.md`, local comparison HTML/PNG | Measured results, before/after annotated evidence, restarted healthy app | Focused checks and browser journeys | No production deployment |
