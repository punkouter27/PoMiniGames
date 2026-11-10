# PoCapitol — Product Requirements Document

Status: Initial implementation requested on 2026-11-09 using the working defaults below.
The delivered first slice is a stylized procedural game, not a photorealistic reconstruction.
Sensitivity adjustment and further difficulty/accessibility tuning remain follow-up scope.

## 1. Existing-project alignment

PoCapitol is a proposed addition to PoMiniGames, not a replacement or a standalone app.
The existing product is a collection of instant-play games with shared navigation,
settings, game introductions, results, and player services. Recent development has
expanded game modes, tournaments, visual presentation, and shared player experiences.

The working vision is to preserve that collection and add one third-person action game.
Existing games and their behavior remain unchanged.

The current root specification and capability map focus on PoMule. They do not yet
describe PoCapitol. This draft supplements rather than replaces those documents.
Updating module ownership, technical specifications, plans, and code requires the
subsequent approval gates requested by the product owner.

## 2. Objective and confirmed concept

Create **PoCapitol**, a third-person shooter inspired by January 6, 2021, with a
recognizable three-dimensional portrayal of the U.S. Capitol grounds and interiors.
The human player starts outside alongside computer-controlled rioters, progresses
inside, and wins by reaching a congressional chamber.

January 6 involved certification of electoral votes. The game must not describe that
event as a legislative vote. Congress has separate House and Senate chambers; the
specific destination remains a product decision.

### Working assumptions, not confirmed decisions

- The first release is one short, replayable single-player scenario for adults.
- The House chamber is the provisional destination.
- Combat, characters, and progression are explicitly fictional, not a claim that the
  historical attack unfolded as a shooter scenario.
- Companions and opposition are fictional characters, not identifiable historical people.
- Violence is non-graphic; there are no assassination objectives.
- Architectural fidelity means recognizable public surroundings and selected interiors,
  not a security-accurate building model or a reconstruction of actual breach methods.
- PoCapitol follows the existing PoMiniGames player experience where applicable.
- Public rankings, multiplayer, a spectator demo, and long-term progression are deferred.

## 3. User personas and target segments

| Persona | Motivation | Product need |
|---|---|---|
| Existing PoMiniGames player | Try another game without leaving the collection | Familiar entry, settings, results, and return navigation |
| Adult action-game player | Complete a tense, short third-person scenario | Readable objectives, reliable controls, consistent combat |
| Historically curious player | Recognize the location and understand its context | Clear factual context and explicit fictional departures |
| Replay-focused player | Improve through repeated attempts | Clear failure feedback, fair rules, fast restarts |

Children, operational training users, and players seeking a documentary reconstruction
of individual acts of violence are not target segments.

## 4. Epics and prioritized user stories

P0 is required for the initial release. P1 follows only after P0 is accepted.
P2 is a future option, not a commitment.

| Priority | Epic / user story | Acceptance criteria |
|---|---|---|
| P0 | Discovery: As an existing player, I can find PoCapitol in the game collection. | Its name, premise, content notice, and available mode are visible before starting; other games remain accessible. |
| P0 | Informed start: As a player, I understand what I am about to play. | Introduction explains the objective, controls, failure conditions, historical inspiration, and fictional treatment; leaving is possible without starting. |
| P0 | Outside start: As a player, I begin with the rioter-side group outside the Capitol. | Every new attempt begins in the designated exterior area with the correct initial objective and companion state. |
| P0 | Third-person control: As a player, I can move, look, aim, fire, and interact. | Controls are explained; the camera supports navigation and aiming; necessary interactions have readable feedback. |
| P0 | Recognizable setting: As a player, I recognize the Capitol and selected interior spaces. | An approved visual-reference checklist covers the exterior and selected interiors; playable and inaccessible areas are clear; fictional alterations are disclosed. |
| P0 | Progression: As a player, I can advance from outside to the chamber objective. | A complete playable journey exists; objectives update when milestones are reached; companions cannot permanently obstruct it. |
| P0 | Combat: As a player, I understand threats and consequences. | Attacks, hits, damage, and incapacitation are distinguishable; combat is non-graphic; no named historical person is a target objective. |
| P0 | Completion: As a player, I know when I win or lose. | Reaching the destination alive after required milestones wins; incapacitation fails; either outcome ends active combat and shows the appropriate result. |
| P0 | Session control: As a player, I can pause, restart, and leave. | Pause suspends damage and progression; restart resets the attempt; leaving returns to the collection without trapping controls. |
| P0 | Shared preferences: As a returning player, I retain relevant settings. | Applicable volume, motion, and input preferences are respected; unavailable control options are not advertised. |
| P1 | Historical context: As a curious player, I can distinguish history from invention. | Context is available outside active combat; factual claims have attributable sources; fictional encounters and dialogue are labeled accordingly. |
| P1 | Accessibility: As a player, I can adjust the experience. | Camera sensitivity, captions for essential speech, readable status cues, reduced motion, and difficulty choices are available. |
| P2 | Expanded play: As a returning player, I may gain additional modes. | Multiplayer, spectator demos, rankings, and additional scenarios require separate scope approval. |

## 5. Core workflows and state machines

### Main journey

Game collection -> PoCapitol introduction -> Content notice and briefing ->
Exterior start -> Scenario milestones -> Interior progression ->
Destination reached -> Results and historical context -> Replay or return.

These are narrative stages, not descriptions of real access routes.

### Session states

Introduction -> Ready -> Active.
Active can transition to Paused, Completed, Failed, or Abandoned.
Paused can transition to Active, a fresh attempt, or Abandoned.
Completed and Failed can transition to a fresh attempt or the collection.

Only Active permits movement, damage, combat, and objective progression.
An attempt has exactly one final outcome once it ends.

### Objective states

Locked -> Available -> Completed.
Objectives become available only when their prerequisites are satisfied.
Completion cannot be undone within the same attempt.
The destination cannot trigger victory before required milestones are complete.

### Player states

Active -> Injured -> Incapacitated.
Incapacitation ends the attempt. Recovery rules, if any, depend on the approved
difficulty design and must be explained before play.

## 6. Scope boundaries

| In scope for the first release | Out of scope |
|---|---|
| One new game within PoMiniGames | Replacing the collection or redesigning unrelated games |
| One human with computer-controlled companions | Cooperative or competitive multiplayer |
| Third-person movement and fictional shooter combat | Detailed real-world tactical or breach instruction |
| Recognizable grounds and selected interiors | Complete survey-accurate or security-sensitive reconstruction |
| Exterior-to-chamber objective | Reenacting every event of January 6 |
| Clear win, loss, pause, restart, and exit | Persistent campaigns, crafting, or equipment economies |
| Content notices and historical distinctions | Claims that fictional combat is historical evidence |
| Existing shared player experience where applicable | New paid services, purchases, or monetization |

## 7. Business rules and data invariants

1. The public game name is PoCapitol.
2. Each scenario has exactly one designated victory destination.
3. Only the living human player's arrival can satisfy the arrival condition.
4. Companions cannot complete the scenario on the player's behalf.
5. Required milestones must be complete before victory.
6. Completed, Failed, and Abandoned are mutually exclusive final outcomes.
7. Final outcomes cannot be changed by later damage or movement.
8. A restart resets player health, objectives, companions, encounters, and attempt timing.
9. Paused attempts accumulate neither active play time nor gameplay consequences.
10. Settings are preferences, not mission progress; restarting must not erase them.
11. Historical statements remain distinguishable from fictional characters and encounters.
12. Architectural presentation must not imply operationally accurate security arrangements.
13. Identifiable real people are not assassination targets or kill-based achievements.
14. Public rankings and combat scoring are not part of this release; neither is implied by
    the platform's existing support for other games.
15. Any future scoring proposal must specify fair comparisons and must not reward counts
    of historical victims or political affiliation.

## 8. Edge cases and player-facing failures

- If loading fails, explain that the game did not start and offer retry or return.
- If an attempt is interrupted by leaving or reloading, restart rather than promise
  unapproved saved progress.
- If the player becomes stuck, provide restart and exit; do not mark the attempt complete.
- If damage and destination arrival coincide, incapacitation takes precedence for that
  gameplay step; this rule must be consistent across attempts.
- If a companion becomes incapacitated or stuck, required progression remains possible.
- If the game cannot support a device or control method, say so before starting.
- If contextual material is unavailable, do not replace it with invented historical claims.

## 9. Product success criteria

1. A player can discover, start, finish, replay, and leave PoCapitol within the collection.
2. One complete exterior-to-destination journey works without a progression dead end.
3. Victory, failure, pause, and restart satisfy every stated state rule.
4. Every item on the approved visual-reference checklist is reviewed and accepted.
5. The introduction and result screens clearly distinguish fictional play from history.
6. No required objective depends on targeting an identifiable historical individual.
7. Relevant shared preferences work, and existing games retain their behavior.
8. Before build approval, the owner accepts supported devices, control methods, target
   session length, visual fidelity, difficulty, and the final destination.

## 10. Five non-technical questions pending approval

1. **Identity:** Is PoCapitol an explicitly alternate-history action game, a historical
   examination, or satire? Recommended working assumption: alternate-history action.
2. **Destination:** Should victory mean entering the House chamber or the Senate chamber,
   and should entry immediately end the scenario? Working assumption: House, immediate ending.
3. **Combat:** What fictional opposition should appear, what equipment is appropriate,
   and how intense should violence feel? Working assumption: fictional, non-graphic combat.
4. **Authenticity:** Which publicly recognizable exterior and interior landmarks are essential?
   Working assumption: selected recognizable spaces, with disclosed fictional alterations.
5. **Audience and scale:** Which devices and controls matter, and how long should a first
   successful attempt take? Working assumption: a short adult single-player experience;
   devices and duration remain uncommitted.

## 11. Approval and next gates

The owner subsequently requested implementation and autonomous completion. The working
defaults are therefore used for the initial single-player slice: adult alternate-history
framing, fictional non-graphic pulse combat, Story/Standard difficulty, and the House-inspired
chamber destination. Technical ownership and implementation boundaries are tracked in the
capability map and specification. The five questions above remain useful future-direction
choices, not claims that the owner individually selected those defaults.
