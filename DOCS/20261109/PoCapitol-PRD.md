# PoCapitol — Product Requirements Document

Status: Initial implementation, crowd/demo expansion, and the realism, sound, steering,
graphics and armed-demo pass (section 13) requested on 2026-11-09. Section 13 governs where
it conflicts with earlier sections.
The delivered presentation is stylized, not a photorealistic reconstruction.
Sensitivity adjustment and further difficulty/accessibility tuning remain follow-up scope.

## 1. Existing-project alignment

PoCapitol is an addition to PoMiniGames, not a replacement or a standalone app.
The existing product is a collection of instant-play games with shared navigation,
settings, game introductions, results, and player services. Recent development has
expanded game modes, tournaments, visual presentation, and shared player experiences.

The working vision is to preserve that collection and add one third-person action game.
Existing games and their behavior remain unchanged.

The root specification and capability map describe PoCapitol while retaining the
existing PoMule material. This document contains product requirements, not technical architecture.

## 2. Objective and confirmed concept

Create **PoCapitol**, a third-person shooter inspired by January 6, 2021, with a
recognizable three-dimensional portrayal of the U.S. Capitol grounds and interiors.
The human player starts outside alongside computer-controlled rioters, progresses
inside, and wins by reaching a congressional chamber.

January 6 involved certification of electoral votes. The game must not describe that
event as a legislative vote. Congress has separate House and Senate chambers; the
working destination is the House chamber.

### Confirmed crowd and spectator requirements

- Solo begins with exactly one human and 99 independently moving, fighting NPC raiders.
- Opposition represents Capitol Police; individual identities and encounters are fictional.
- Demo begins with exactly 100 computer-controlled raiders and no participating human.
- The spectator camera follows the living raider closest to legitimate chamber arrival:
  completed prerequisite milestones first, remaining navigable distance second.
- The camera changes subject when the leader changes or is incapacitated.
- Demo starts without player input, automatically restarts after its ending, and never
  saves player wins or losses. It is available from the game collection and shared demo reel.
- Improve publicly recognizable architectural and period appearance wherever feasible:
  dome and facade, selected interiors, winter clothing, flags, and police riot equipment.
  Invented layout, scale, artwork, equipment counts and combat must remain disclosed.

### Working assumptions, not confirmed decisions

- The release is one short, replayable scenario for adults, with solo and spectator modes.
- The House chamber is the provisional destination.
- Combat, characters, and progression are explicitly fictional, not a claim that the
  historical attack unfolded as a shooter scenario.
- Companions and opposition are fictional characters, not identifiable historical people.
- Violence is non-graphic; there are no assassination objectives.
- Architectural fidelity means recognizable public surroundings and selected interiors,
  not a security-accurate building model or a reconstruction of actual breach methods.
- PoCapitol follows the existing PoMiniGames player experience where applicable.
- Public rankings, multiplayer and long-term progression are deferred.

## 3. User personas and target segments

| Persona | Motivation | Product need |
|---|---|---|
| Existing PoMiniGames player | Try another game without leaving the collection | Familiar entry, settings, results, and return navigation |
| Adult action-game player | Complete a tense, short third-person scenario | Readable objectives, reliable controls, consistent combat |
| Historically curious player | Recognize the location and understand its context | Clear factual context and explicit fictional departures |
| Replay-focused player | Improve through repeated attempts | Clear failure feedback, fair rules, fast restarts |
| Spectator | Watch the autonomous crowd progress | Automatic start/replay, understandable leader-following camera, no player-stat changes |

Children, operational training users, and players seeking a documentary reconstruction
of individual acts of violence are not target segments.

## 4. Epics and prioritized user stories

P0 is required for the initial release. P1 follows only after P0 is accepted.
P2 is a future option, not a commitment.

| Priority | Epic / user story | Acceptance criteria |
|---|---|---|
| P0 | Discovery: As an existing player, I can find PoCapitol in the game collection. | Its name, premise, content notice, and available mode are visible before starting; other games remain accessible. |
| P0 | Informed start: As a player, I understand what I am about to play. | Introduction explains the objective, controls, failure conditions, historical inspiration, and fictional treatment; leaving is possible without starting. |
| P0 | Outside start: As a player, I begin with 99 computer-controlled raiders outside the Capitol. | Exactly 100 raiders including the human; unique independent NPCs; full health and initial objective restored on restart. |
| P0 | Autonomous group: As a player, I advance alongside a functioning crowd. | NPCs navigate scenery, complete their own ordered milestones, confront police and can be incapacitated; they cannot obstruct or win for the human. |
| P0 | Spectator demo: As a viewer, I watch 100 CPU raiders attempt the scenario. | No participating human; leader selected by valid progress and remaining route; camera switches/smoothly follows; all incapacitated fails; successful arrival ends the attempt; automatic replay; no player results saved. |
| P0 | Third-person control: As a player, I can move, look, aim, fire, and interact. | Controls are explained; the camera supports navigation and aiming; necessary interactions have readable feedback. |
| P0 | Recognizable setting: As a player, I recognize the Capitol and selected interior spaces. | An approved visual-reference checklist covers the exterior and selected interiors; playable and inaccessible areas are clear; fictional alterations are disclosed. |
| P0 | Progression: As a player, I can advance from outside to the chamber objective. | A complete playable journey exists; objectives update when milestones are reached; companions cannot permanently obstruct it. |
| P0 | Combat: As a player, I understand threats and consequences. | Attacks, hits, damage, and incapacitation are distinguishable; combat is non-graphic; no named historical person is a target objective. |
| P0 | Completion: As a player, I know when I win or lose. | Reaching the destination alive after required milestones wins; incapacitation fails; either outcome ends active combat and shows the appropriate result. |
| P0 | Session control: As a player, I can pause, restart, and leave. | Pause suspends damage and progression; restart resets the attempt; leaving returns to the collection without trapping controls. |
| P0 | Shared preferences: As a returning player, I retain relevant settings. | Applicable volume, motion, and input preferences are respected; unavailable control options are not advertised. |
| P1 | Historical context: As a curious player, I can distinguish history from invention. | Context is available outside active combat; factual claims have attributable sources; fictional encounters and dialogue are labeled accordingly. |
| P1 | Accessibility: As a player, I can adjust the experience. | Camera sensitivity, captions for essential speech, readable status cues, reduced motion, and difficulty choices are available. |
| P2 | Expanded play: As a returning player, I may gain additional modes. | Multiplayer, rankings and additional scenarios require separate scope approval. |

## 5. Core workflows and state machines

### Main journey

Game collection -> PoCapitol introduction -> Content notice and briefing ->
Exterior start -> Scenario milestones -> Interior progression ->
Destination reached -> Results and historical context -> Replay or return.

These are narrative stages, not descriptions of real access routes.

### Spectator journey

Game collection or demo reel -> automatic 100-CPU start -> closest eligible raider
followed -> updated leader as progress changes -> completion or all incapacitated ->
four-second outcome display -> fresh attempt. Pause/resume and return remain available.
The shared reel can advance independently of the current attempt; no player stats are written.

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
Human incapacitation ends solo; an individual NPC incapacitation does not. Demo ends
unsuccessfully only when no NPC can continue. Recovery rules, if any, depend on the approved
difficulty design and must be explained before play.

## 6. Scope boundaries

| In scope for the first release | Out of scope |
|---|---|
| One new game within PoMiniGames | Replacing the collection or redesigning unrelated games |
| One human + 99 NPCs; optional 100-CPU spectator demo | Cooperative or competitive multiplayer |
| Third-person movement and fictional shooter combat | Detailed real-world tactical or breach instruction |
| Recognizable grounds and selected interiors | Complete survey-accurate or security-sensitive reconstruction |
| Exterior-to-chamber objective | Reenacting every event of January 6 |
| Clear win, loss, pause, restart, and exit | Persistent campaigns, crafting, or equipment economies |
| Content notices and historical distinctions | Claims that fictional combat is historical evidence |
| Existing shared player experience where applicable | New paid services, purchases, or monetization |

## 7. Business rules and data invariants

1. The public game name is PoCapitol.
2. Each scenario has exactly one designated victory destination.
3. Only the living human player's arrival wins solo; a living eligible NPC's arrival wins demo.
4. Companions cannot complete solo on the player's behalf; each has its own required progress.
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
16. Each fresh attempt has exactly 100 raiders: 1+99 in solo or 100 CPU in demo.
17. Incapacitated raiders remain part of that population and are excluded from camera leadership.
18. Demo outcomes never affect player statistics; switching modes must fully reset the scenario.
19. Historical references describe visible motifs, not a literal roster, equipment allocation
    or operational route.

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
9. Both populations, independent NPC progression/combat, camera leadership, automatic
   replay and absence of demo player results can be demonstrated.

## 10. Five non-technical questions pending approval

1. **Identity:** Is PoCapitol an explicitly alternate-history action game, a historical
   examination, or satire? Recommended working assumption: alternate-history action.
2. **Destination:** Should victory mean entering the House chamber or the Senate chamber,
   and should entry immediately end the scenario? Working assumption: House, immediate ending.
3. **Combat refinement:** Capitol Police and riot equipment are confirmed; future
   balance and intensity tuning should retain non-graphic fictional encounters.
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

The owner then explicitly requested the solo 1+99 population, 100-CPU leader-following
demo, Capitol Police, flags and riot shields, and greater historical visual fidelity.
Those are confirmed requirements, not pending choices.

## 12. Public visual references and limits

- [Architect of the Capitol: Dome](https://www.aoc.gov/explore-capitol-campus/buildings-grounds/capitol-building/capitol-dome):
  colonnaded drum, ribbed dome and crowning silhouette.
- [Architect of the Capitol: Rotunda](https://www.aoc.gov/explore-capitol-campus/buildings-grounds/capitol-building/rotunda):
  concentric floor rings, pilasters, framed historical artwork and inner dome.
- [House history: rostrum](https://history.house.gov/Exhibitions-and-Publications/House-Chamber/Rostrum/):
  walnut rostrum, Speaker's chair, central flag and symbolic bronze decoration.
- [Smithsonian: January 6 collections](https://americanhistory.si.edu/press/releases/smithsonian-continues-collecting-artifacts-jan-6-capitol-attack-2):
  flags/campaign banners, helmets, boots, protective vests and winter garments.
- [National Security Archive: shield testimony](https://nsarchive.gwu.edu/briefing-book/foia/2021-05-04/capitol-riot-documents-you-should-read-part-3):
  documented riot shields, including uneven availability; not every historical officer had one.

These references inform original simplified artwork. They do not establish that the
scene is a measured reconstruction, that all police wore identical equipment, or that
the fictional pulse combat and room connections occurred historically.

## 13. Realism pass, sound, steering, graphics and armed demo (2026-11-09)

The owner then requested, in order: sound, library-based crowd steering and adaptive
graphics; all twenty items of a realism review; and an armed spectator demo. These are
confirmed requirements. Where they conflict with earlier sections, this section governs.

### What changed

| Earlier requirement | Now |
|---|---|
| Fictional pulse combat on both sides | Solo play has no firearms: the crowd pushes, police use shields, batons, spray, gas and flash-bangs |
| Twelve police at fixed posts | Five lines of 44 that hold, bow, break and fall back, with reinforcements to 64 |
| Exactly 100 raiders (rules 16, 17) | Exactly 128 protestors: 1 + 127 in solo, 128 CPU in demo |
| Start on the forecourt | Start out on the grass, well back from the building |
| Nobody inside | 64 staff and members shelter in the chamber and are evacuated |
| Every raider advances | About 30% push; the rest follow, film, mill about or act as street medics |
| Four milestones ending inside the House chamber | Six milestones ending at barricaded chamber doors; the chamber was evacuated and is never entered |
| Untimed attempt | A 12:50 pm to 6:00 pm clock at one minute per second; the curfew ends the attempt |
| One solo role | Crowd, police line, or observer |
| Demo: same rules as solo | Demo: armed variant, both sides fire, those hit are eliminated |
| Demo restarts after four seconds | Six seconds, to allow the closing shot |
| Rule 13/14 wording on combat scoring | Unchanged: still no score for harming anyone and no public ranking |

### Confirmed additions

- West-front setting: inauguration stands, bike-rack barricades, Crypt, Statuary Hall and a
  House corridor, still on an invented straight-line route.
- An unsimulated distant crowd for scale; varied dress, banners, signs and raised phones.
- Morale, retreat and recovery; crowding that slows movement; medics and an aid station.
- Building wear that follows progress: toppled racks and ropes, cracked panes, papers, gas haze.
- Synthesized layered sound on the shared audio bus.
- An "On the day" strip of approximate real times, shown beside the fictional clock.
- An aftermath panel on every result: clearing, curfew, reconvening, certification, charges
  and the January 2025 clemency.
- Adaptive graphics with an Auto/Low/High choice that is remembered.

### Rendering realism (2026-11-09, second request)

The owner asked for all ten items of a scene-realism review. Delivered, still stylized:

1. Image-based light from the sky, so materials stop reading as plastic.
2. Contact shadows under every near and far figure; feet sit on the actual floor height.
3. Flags and banners ripple in the wind, and far flags have poles.
4. A January overcast: cloud-deck sky dome, exponential haze, and a sun on its real path for the date.
5. World-mapped surface detail: ashlar coursing, paving joints, patchy winter lawn.
6. Figures with hip and shoulder joints, arms that swing, push or film, varied height and build,
   puffers, hoods, scarves and bare heads; the far crowd as painted, swaying sprites.
7. Gas, pepper spray and flash-bangs as soft sprites that drift with the wind.
8. Post-processing: ambient occlusion, bloom, transient depth of field, a winter grade and grain.
9. Architecture: 36-column peristyle, attic and dome windows, lantern colonnade, a robed bronze
   figure (no likeness), roof balustrades, window pediments, wrapped and braced stands, branching
   bare trees, grounds lamp posts.
10. Camera: a narrower lens, a trailing hand-held spectator camera, a step bob, and a jolt from a
    nearby flash-bang. Motion effects and grain respect reduced motion.

All of it scales down with the existing graphics ladder (Auto, Low, High).

### Rigged figures and in-play focus (2026-11-10, third request)

The owner chose rigged models over stylized blocks, and depth of field during play.

1. Near figures are one low-poly rigged person: 17 bones, six tinted regions (coat, sleeves,
   trousers, skin, boots, gloves), about 900 vertices, no face. It ships as
   `wwwroot/models/pocapitol/figure.glb` (41 KB), written by `scripts/pocapitol-figure.mjs` from
   `js/pocapitol/rig.js`; if the file cannot load, the game builds the same figure in code.
2. All near figures are one skinned mesh with a bone texture: one draw call per pass, and
   shadows, ambient occlusion and depth of field all see the posed bodies.
3. Poses: walking with bending knees and elbows, idle weight shifts and glances, pushing with a
   forward lean, filming with the phone at eye level, flag poles in hand, shields on the forearm,
   baton and spray, aiming in the armed demo, staggering, sitting when out, stooping when helped,
   lying when hit in the armed demo.
4. Hats, hoods, helmets, visors, scarves, vests and backpacks follow the head, neck and chest
   bones; phones, flags, shields, batons and guns are held at the hand and stay upright.
5. In play, the view loses focus briefly when the player is struck, for longer on going down,
   and when a flash-bang lands within 12 m (half strength under reduced flashing or motion).
   Top quality only, like every depth of field.

### Limits that still hold

- Staff and members are non-combatants. They cannot be targeted, reached or harmed in any
  mode, including the armed demo; they are evacuated before the crowd can reach the doors,
  and the doors never open. This limit is not open to tuning.
- No real breach route, security-accurate layout or operational detail.
- No identifiable real person, as a character, a likeness or a target.
- No injury is depicted in any mode. Eliminated figures in the armed demo drop and stay down.
- The armed demo is labeled on screen as something that did not happen.
- Historical statements stay distinguishable from invention; if a source is unavailable the
  claim is not made.

### Open questions for the owner

1. Should the armed variant remain demo-only, or also be offered as a solo option?
2. Should Standard difficulty be winnable by the crowd without the human, or stay a
   stalemate that usually ends at the curfew?
3. Should the police-line and observer roles record local results?
4. The armed demo's Standard difficulty usually ends with every protestor eliminated and
   Story with every officer eliminated. Is that the balance you want to watch?
