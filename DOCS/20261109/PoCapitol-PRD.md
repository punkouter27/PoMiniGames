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

### Advanced Graphics, Acoustics & Physics Overhaul (2026-11-10)

Implemented all 10 areas of the graphics, audio, physics, and interface overhaul:

1. **Web Audio Micro-cues (`ui.js`):** Positional UI audio for button hovers, taps, primary confirms, and menu slide whooshes with stereo panning based on on-screen position and pitch variation per button identity.
2. **UI Micro-interactions (`ui.js`, `PoCapitolPage.razor.css`):** Button press squash and spring overshoot via Web Animations API, pointer coordinate shockwave ripples, and ghost element exit slides when Blazor unmounts panels.
3. **Hardware-accelerated Shaders (`ui.js`):** WebGL2 background canvas with domain-warped FBM fluid dynamics, chromatic dispersion along panel boundaries, and procedural ripple propagation.
4. **Glassmorphism (`PoCapitolPage.razor.css`):** Hardware-accelerated backdrop blur (`backdrop-filter: blur(16px) saturate(1.4)`), gold specular edge highlights, and reduced-transparency fallbacks.
5. **Procedural Impact Synthesis (`audio.js`):** Physical modal impact synthesis (body, baton, marble, metal, ground) driven by collision kinetic energy (Joules), resonant modes, and target mass ratios.
6. **Acoustic Spatialization & Geometric Reverb (`audio.js`):** True 3D HRTF listener panning, Sabine decay reverb impulse responses calculated from room dimensions (Crypt, Rotunda, Statuary Hall, outdoors slapback), wall transmission muffling, and crowd friction noise scaled by shear velocity.
7. **Continuous Collision Detection & Real Mass Physics (`physics.js`, `steering.js`):** Sub-stepped sweep collision prevention, realistic mass distribution (58-92 kg raiders, 90-102 kg officers), momentum exchange with ground friction deceleration, and uniform spatial grid neighbor acceleration.
8. **High-Density GPU Particle Bursts (`bursts.js`):** 16,000-particle vertex-shader closed-form physics (sparks, dust puffs, ground bounces, drag) running with zero per-frame CPU allocations.
9. **Dynamic Wear Decals (`decals.js`):** Instanced scuffs, blast scorch marks, and chemical gas stains dynamically placed on surfaces upon physical impacts and tinted by daylight levels.
10. **Dynamic Contact Lighting (`scene.js`):** Dynamic flare point lights synchronized to physical impacts and muzzle flashes with rapid exponential decay.

### Atmospheric, Campus GIS, Formations & Telemetry Overhaul (Features 2, 3, 4, 5, 7, 8)

Delivered the 6 selected high-value features incorporating open-source APIs, GIS spatial models, audio speech synthesis, and real-time tactical overlays:

1. **Feature 2: Atmospheric Weather API (`weather.js`, `scene.js`):**
   - Seamless integration of the Open-Meteo Historical Archive API (Jan 6, 2021) and Live Washington D.C. Weather API.
   - Live wind vector, temperature, cloud cover deck, and fog density dynamically feed Three.js sky scattering, flag rippling, and particle physics.
   - Includes instant built-in historical archive fallback if offline.
2. **Feature 3: OpenStreetMap 3D Grounds Campus (`campus.js`, `scene.js`):**
   - Procedural low-poly architectural reconstruction of authentic Capitol Hill campus surroundings matching OSM coordinates:
   - Library of Congress (Thomas Jefferson Building) with reading room dome and pavilions.
   - Supreme Court of the United States with hexastyle Corinthian pediment and marble approach.
   - Capitol Reflecting Pool & Ulysses S. Grant Memorial on the West Lawn axis.
   - Surrounding avenues (Constitution Ave, Independence Ave, First St) with curbs and stone balustrades.
3. **Feature 4: Synthesized Tactical Police Radio & Crowd Acoustics (`audio.js`):**
   - Procedural dual-tone squelch chirps (1350 Hz to 950 Hz) and bandpass transceiver filtering.
   - Web Speech Synthesis API voice dispatcher callouts ("Command, perimeter line taking heavy pressure", "Hold the Crypt entrance", "Perimeter line breach! All units fall back!").
   - Spatialized 3D HRTF crowd chanting bursts and radio audio pinned to squad leaders.
4. **Feature 5: Coordinated Shield Formations & Dynamic Fallback (`steering.js`, `world.js`):**
   - Coordinated Roman/Riot shield wall formation (`shield-lock`) with mutual lateral bracing.
   - Staggered fighting fallback when line integrity drops below 30% to maintain rear guard.
   - Crowd pressure waves: pushers intelligently funnel toward broken barrier seams and gaps.
5. **Feature 7: Real-time Tactical Radar & Crowd Pressure Heatmap (`radar.js`, `PoCapitolPage.razor`):**
   - Interactive HUD radar tablet overlay rendering full campus blueprint and police line integrity bars.
   - Dynamic crowd pressure density heatmap gradient (cyan &rarr; yellow &rarr; crimson) highlighting crush zones and barrier stress points.
   - Clickable radar sectors for immediate unit raycasting and inspection.
6. **Feature 8: Deep Telemetry Unit Inspector & Camera Latching (`inspector.js`, `PoCapitolPage.razor`):**
   - 3D viewport raycasting inspection on demonstrator or police officer click.
   - Ground target reticle ring in Three.js and sleek glassmorphic Telemetry HUD Card (health, stamina, morale, gear, mass, current status, line assignment).
   - 1-click **"Latch Camera"** feature that locks the third-person or spectator follow camera onto any chosen demonstrator or police officer.

## 15. Next-Gen Realism: Graphics, Acoustics, and Physics Overhaul (2026-11-10)

Production upgrade of the visual, acoustic, and collision engines to sustain a 30 FPS floor on desktop hardware while delivering high-end rendering and procedural acoustic simulation:

1. **Screen-Space Global Illumination (SSGI) (`post.js`):**
   - Poisson-disk screen-space raymarching of color and linear depth buffers.
   - Diffuse multi-bounce indirect light bounce calculating Lambertian irradiance transfers from sunlit marble, lawns, and banners onto shaded recesses.
   - Blue-noise spatial dithering preventing banding across broad colonnades.
2. **Screen-Space Reflections (SSR) with Roughness Jitter & Fresnel (`post.js`):**
   - Screen-space depth raymarching along the view-space reflection vector $\mathbf{R} = \mathrm{reflect}(\mathbf{V}, \mathbf{N})$.
   - Schlick Fresnel term ($F_0 + (1 - F_0)(1 - \cos\theta)^5$) generating glossy specular reflections across wet winter pavement, Crypt marble slabs, and riot shield faceplates.
3. **Screen-Space Contact Shadows (SSCS) (`post.js`):**
   - Short-ray depth buffer raymarching along the directional sunlight vector.
   - Resolves sub-meter contact occlusion, solidly grounding actor boots, barrier feet, and architectural pilasters where broad GTAO is too diffuse.
4. **Volumetric Refraction & Chromatic Dispersion (`look.js`, `crowd.js`):**
   - Physically based polycarbonate material (`MeshPhysicalMaterial`) with $IOR = 1.585$, optical transmission $0.88$, and Beer-Lambert volumetric thickness absorption.
   - Custom vertex/fragment chromatic dispersion shader fringing red and blue wavelengths across faceted shield bevels and curved visor lenses.
5. **Screen-Space Subsurface Scattering (SSSS) & Micro-Detail Wrap Lighting (`look.js`, `crowd.js`):**
   - Curvature wrap-lighting approximation ($\max(0, (\mathbf{N} \cdot \mathbf{L} + w) / (1 + w))$) with red dermis scatter bleed (`#d95a42`) at the light-shadow terminator.
   - Sheen and micro-fiber roughness modulation across coats, hoods, and knit winter beanies.
6. **Procedural Modal Impact Acoustic Synthesis (`audio.js`):**
   - Exact modal frequency matrices for body tissue, polycarbonate riot batons, architectural marble, and structural steel barricades.
   - Dynamic collision energy $E = \frac{1}{2} m v^2$ (Joules) drives resonant mode excitation count, decay times, and high-frequency contact clicks.
7. **Multi-Agent HRTF Binaural Spatialization & Geometric Sabine Reverb (`audio.js`):**
   - Dynamic crowd shear velocity modulates the continuous fabric and footwear friction hiss bed.
   - Physical Sabine reverberation time $RT_{60} = 0.161 \frac{V}{S \cdot \alpha}$ computed from real chamber volumes and stone absorption across Crypt, Rotunda, and Statuary Hall.
   - Individual footfall spatialization routed through 3D HRTF panners.
8. **High-Density GPU Compute Particle Bursts (`bursts.js`):**
   - Closed-form GPU vertex flight solver ($p = p_0 + v(1 - e^{-kt})/k - \frac{1}{2}gt^2$) supporting 16,000+ live particles in a single draw call with ground bounce.
   - Added winter snow flurry and ice crystal layers with sinusoidal wind turbulence.
9. **Continuous Collision Detection (CCD) & Sub-Stepping Physics (`physics.js`):**
   - Multi-substep swept continuous collision detection (`subStepSweep`) preventing high-velocity tunneling through columns, barricades, and bodies.
   - Realistic actor mass distribution ($58\text{ kg}$ to $104\text{ kg}$) and elastic-plastic momentum exchange conservation.
10. **Headless Blender Pipeline (`scripts/blender/pocapitol-asset-pipeline.py`):**
    - Automated batch decimation, LOD generation (LOD0: 100%, LOD1: 50%, LOD2: 25%), ambient occlusion/normal map baking, and Draco-compressed `.glb` export via `blender --background`.

## 16. Comprehensive Scene Realism Overhaul (2026-11-10)

Production delivery of the Top 10 realism upgrades across architectural detailing, physical lighting, weather shaders, atmospherics, and optics:

1. **Dynamic Shadow Frustum & Contact Shadow Coupling (`scene.js`, `post.js`):**
   - Focused $76\text{m} \times 88\text{m}$ shadow frustum smoothly tracking active camera target, quadrupling texel resolution.
   - Screen-space contact shadows (SSCS) activated at quality $\ge 3$ for sub-meter grounding.
2. **Classical Architectural Orders & Capitals (`scene.js`):**
   - Columns upgraded with stepped Attic plinths, circular torus bases, 24-faceted fluted shafts, astragal collars, and Corinthian capitals.
   - Added dentil molding blocks beneath the pediment cornice.
3. **Slope-Aware Winter Frost & Snow Layer (`look.js`):**
   - Normal slope dot-product detection deposing white frost along horizontal ledges, balustrades, capitals, and dead winter grass.
4. **Puddle Pooling & Specular Wetness (`look.js`, `post.js`):**
   - Plaza depression mask darkens paving albedo and drops surface roughness to $0.04$, generating glossy reflections of sky and police beacons via SSR.
5. **Volumetric Sun Shafts / God Rays (`post.js`):**
   - Radial depth raymarching from projected sun position creating atmospheric golden-grey sunbeams streaming across Capitol facades.
6. **FXAA Sub-Pixel Edge Smoothing (`post.js`):**
   - Dedicated edge-preserving anti-aliasing pass eliminating stair-stepping on bike racks, wires, and balusters.
7. **Exhaled Winter Condensation Breath Vapor (`bursts.js`, `scene.js`):**
   - GPU particle bursts emitting translucent condensation vapor puffs rising from player, demonstrator, and police faces.
8. **Idle Cold Shivering & Ground IK (`crowd.js`):**
   - High-frequency chest/head shivering tremors during idle state and grounded boot positioning.
9. **Instanced Ground Clutter & Debris (`scene.js`):**
   - 96 instanced protest placards, wooden stakes, and debris along exterior conflict paths with zero draw call bloat.
10. **Documentary Camera Lens Simulation (`post.js`):**
    - Barrel lens distortion, peripheral chromatic aberration fringing, and authentic 2021 news sensor grain.

## 17. Tactical Shooter & January 6 Combat Realism Pass (2026-11-10)

Production delivery of the Top 10 tactical combat fidelity upgrades tuned to authentic January 6 conflict dynamics and modern tactical shooter physics:

1. **Authentic Ballistics & Velocity Arc (`world.js`):**
   - True 3D projectile trajectory with vertical gravity arc ($g = 9.8\text{ m/s}^2$) and sub-step swept segment ray intersection.
2. **Supersonic Bullet Cracks & Near-Miss Spatial Fly-bys (`world.js`, `audio.js`):**
   - Near-miss detection ($< 2.5\text{m}$) triggering a $1.2\text{ms}$ supersonic N-wave snap followed by Doppler-shifted pitch sweeps panned in 3D binaural space.
3. **Battlefield Combat Suppression System (`world.js`, `post.js`, `scene.js`, `audio.js`):**
   - Combat stress accumulator bleeding off with time; expands peripheral vignette, desaturates image color saturation, and induces high-frequency camera micro-tremors and auditory tinnitus.
4. **Skeletal Multi-Zone Hitboxes & Tactical Armor (`world.js`):**
   - Discrete hit zones (Head, Torso, Limbs); police wear tactical Kevlar vests absorbing damage and riot helmets deflecting glancing rounds with ricochet pings.
5. **Surface Ricochets & Angle-Dependent Deflection (`world.js`, `audio.js`, `bursts.js`, `decals.js`):**
   - Shallow-angle impacts on marble columns and metal bike-rack barricades spawn ricochet whine audio and spark streaks.
6. **Procedural Weapon Recoil, Camera Punch & Shell Casings (`scene.js`, `bursts.js`):**
   - Gunshots apply upward camera recoil pitch and backward dolly zoom with spring-damper recovery, ejecting tumbling brass shell casings with ground bounce.
7. **Directed Impact Momentum Transfer & Kinematic Stagger (`world.js`, `physics.js`):**
   - Kinetic momentum transfer $\vec{J} = m \cdot \vec{v}$ delivers physical knockback along projectile flight vectors, causing running targets to stumble dynamically.
8. **Surface Fracture Spall Chunks & Impact Decals (`bursts.js`, `decals.js`):**
   - Limestone chips and pulverized white marble dust burst outward from architectural strikes, leaving darkened bullet impact decals.
9. **Volumetric Muzzle Flash Dynamic Point Light (`scene.js`, `bursts.js`):**
   - Instantaneous $240\text{ lux}$ point light casting warm illumination across faces and columns for $30\text{ms}$, accompanied by drifting muzzle smoke puffs.
10. **Concussive Flash-Bangs & Aerodynamic CS Tear Gas Volumetrics (`bursts.js`, `post.js`, `audio.js`):**
    - Faithful crowd control munitions: flash-bang retinal whiteout bloom in `GradeShader` fading through burned after-images, and dense drifting CS tear gas particulate clouds.

### Hit reactions and collapses (2026-11-10)

How a body answers a round, built on the existing mass and knockback model:

1. **Staged collapse instead of one rotation (`collapse.js`, `crowd.js`):** A downed figure used
   to snap flat. It now goes through three beats — the weight goes, the knees buckle, the body
   tips — then settles and holds, and a settled body stops being re-posed every frame.
2. **Directional falls (`collapse.js`):** The tip axis is computed in the body's own frame from
   the projectile's flight vector, so a person falls away from the round whichever way they were
   facing. A figure struck from the front falls backwards; one struck from behind falls forward.
3. **Hit-zone reactions (`world.js`, `crowd.js`):** Where the round lands is recorded and changes
   the reading. A head hit folds immediately with no bracing; a torso hit buckles at the waist; a
   limb hit staggers with less body rotation. Every zone adds a catch step on the back foot.
4. **Impact flinch (`crowd.js`):** A survivor leans away from the round, folds at the spine and
   half-raises an arm for a beat before recovering, scaled by impact strength.
5. **Neighbour disturbance (`world.js`, `crowd.js`):** People pressed against a body that drops
   check their step and lean away. This is render-only: it never touches position, momentum or
   line holding, so crowd balance is unchanged.
6. **Impulse-consistent ballistics (`world.js`):** Reaction direction, tip axis and impact
   strength all derive from the same recorded shot vector and damage, so a hit never disagrees
   with the round that caused it.
7. **Height-correct impact feedback (`bursts.js`):** A body hit now kicks dust off clothing at
   chest, head or leg height rather than at the feet, and the ground scuff on a fall is wider.
   There is no blood and no dismemberment in any mode.
8. **Performance (`crowd.js`):** Death dynamics are keyed per body and cleared on restart; a body
   that has settled reuses its cached pose, so a field of casualties costs nothing extra and the
   adaptive governor keeps its budget.

### Harm measurement (2026-11-10)

The demo quantifies harm as numbers, without drawing injury. `harm.js` is a coarse, explicitly
non-clinical model; `world.js` applies it per hit and bleeds it forward each tick; `inspector.js`
publishes it in the unit telemetry panel.

1. **Injury severity (`harm.js`):** a 1..6 score in the spirit of AIS. Zone dominates (head beats
   torso beats limb), impact energy raises it, and a vest lowers it for the body but never for the
   head.
2. **Estimated blood loss (`harm.js`):** an uncontrolled bleed rate in mL per minute per severity,
   accumulated over the attempt. A casualty who is already down loses volume more slowly.
3. **Haemorrhage class:** share of an estimated circulating volume (about 70 mL/kg) — none, I, II,
   III or IV.
4. **Triage category:** Minimal, Delayed or Immediate, driven by severity and by blood loss.
5. **Field totals (`world.js`):** casualties, immediate casualties and total estimated loss for the
   attempt, recalculated each step.
6. **Telemetry (`inspector.js`, `PoCapitolPage.razor`):** selecting a unit shows hits, severity,
   estimated mL, haemorrhage class and triage, as flat fields so the trimmed WASM build needs no
   nested deserialisation.

**This is not medical guidance.** It is a balance and reporting aid for a game, built from round
numbers, and must not be used to predict or inform real clinical outcomes.

### Limits that still hold

- Staff and members are non-combatants. They cannot be targeted, reached or harmed in any
  mode, including the armed demo; they are evacuated before the crowd can reach the doors,
  and the doors never open. This limit is not open to tuning.
- No real breach route, security-accurate layout or operational detail.
- No identifiable real person, as a character, a likeness or a target.
- No injury is depicted in any mode. Eliminated figures in the armed demo drop and stay down;
  the drop is staged as weight, buckle and tip, and nothing further is shown. There is no blood,
  no dismemberment and no wound detail, and that is not open to change.
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

## 18. Crowd physics, verticality, sound, light and camera realism pass (2026-11-11)

Ten changes, all presentational or crowd-physics fidelity. None of them touch the limits in
section 17: no injury is depicted, no real person appears, and there is no real access plan.

1. **The terrace is real (`world.js`, `scene.js`).** The central approach between the stands is
   now four stone treads rising 0.38 m to the portico landing, drawn to match `groundHeight()`
   exactly. Agents have a `groundSlope()` and move slower on it, so the crowd bunches at the foot
   of the steps and drains through them slowly — the choke point a stairway creates in a real
   crowd. The simulation itself is still planar; the height is visual plus a speed cost.
2. **The crowd is incompressible (`world.js`).** Body separation now runs two relaxation passes
   with a stiffness that rises with overlap depth, so a shove travels down a line instead of
   moving one pair. Mass still decides who gives way, and the fallen are still stepped over.
3. **Density is a mechanic, not a heatmap (`steering.js`, `inspector.js`).** Every agent carries
   `density` in people per square metre from the same neighbour query the radar already read.
   Above about 4 people/m² the agent's steering authority is perturbed deterministically, so
   someone packed in the middle is carried by people they cannot see. Telemetry and the
   inspector's status line report it.
4. **Sound is occluded and delayed (`audio.js`).** One-shots are low-passed and attenuated by the
   walls between source and listener, are only partly screened when lined up with a doorway, and
   arrive after `distance / 343` seconds — the propagation delay that makes a big stone room feel
   big.
5. **The eye adapts (`scene.js`).** Tone-mapping exposure eases toward 1.62 indoors and 1.1 out,
   faster going darker than coming back out, and lifts slightly at dusk. A doorway now reads as a
   threshold rather than a texture swap.
6. **One wind moves the scene (`look.js`, `crowd.js`, `particles.js`, `scene.js`).** The weather's
   wind vector is shared by the banner shader, the banners' own orientation, the gas and smoke
   drift and the breath vapour, gusting on top of the mean.
7. **Footprints and rime (`decals.js`, `scene.js`, `crowd.js`).** A boot-sole decal ring records
   where people walked, one print per stride outdoors, and a pale rime builds on hats and
   shoulders over the first several minutes outside.
8. **Everyone walks their own way (`crowd.js`).** Stride length, cadence and an occasionally
   favoured knee are drawn once per person from the same stable trait that already sets their
   height and build.
9. **Phone POV (`scene.js`, `post.js`).** When the spectator camera settles on one of the many
   people filming, it cuts to their screen: portrait crop, hand shake, rolling-shutter skew,
   autofocus hunt and metering pumping, then back out. Disabled under reduced motion.
10. **The day has a shape (`world.js`).** `crowdPressure(elapsed)` peaks around 2:15 pm and falls
    away after 3:00, modulating crowd pace and willingness against the existing 12:50-to-6:00
    clock rather than against frame count.

Verified with the Node engine tests (`tests/pocapitol-*.test.mjs`, 58 passing) and a zero-warning
`dotnet build`.
