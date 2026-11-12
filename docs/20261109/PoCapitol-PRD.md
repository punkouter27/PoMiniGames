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
10. **Headless Blender Pipeline:** removed on 2026-11-12 (section 22). Nothing in the game ever
    loaded its output; the one model, `figure.glb`, is written by `scripts/pocapitol-figure.mjs`.

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

## 19. Spectator direction, after-action reporting, comfort and reliability (2026-11-11)

Five owner-selected additions. None of them touch the limits in section 17: still no injury
depicted, no real person, no breach route, no score, and no public ranking.

1. **Auto-director for the demo (`director.js`, `scene.js`, `index.js`).** The spectator camera
   no longer follows only the raider closest to the doors. A coarse 10 m heat grid is fed by the
   impact events the simulation already emits, decays over ~4.5 s, and scores each living raider
   by nearby heat, milestone progress, crowding and proximity to the holding line. The camera
   cuts on a 4-8 s dwell with hysteresis, so it does not flap between two equally interesting
   people. "Follow leader" remains one choice away in the options sheet, and the HUD and radar
   beacon both name the subject actually on screen.
2. **After-action report (`report.js`, `index.js`, page).** Every attempt is sampled once a
   second: police-line integrity, the pressure against it, raiders and police standing,
   casualties, and the time each milestone was crossed. The end card gains a chart of integrity
   against pressure with milestone ticks, six flat figures, and **Export CSV**, **Save chart
   (PNG)** and **Copy summary**. The same report is available from the Tab panel for the demo,
   which has no end card. It is a record of a fictional attempt, not a score.
3. **Comfort and access (`prefs.js`, page, `radar.js`).** Camera sensitivity and field of view,
   captions for the synthesized radio traffic, a high-contrast HUD, a tablet or Okabe-Ito radar
   palette, and a key map with the arrows hard-wired as a fallback. Reduced motion, reduced
   flashing and the app-wide colour-safe palette are still owned by the shared app settings and
   are respected rather than duplicated. Settings persist per browser.
4. **Real Capitol Hill footprints (`scripts/pocapitol-campus.mjs`, `campus.js`,
   `campusData.js`).** The city around the hand-built grounds now uses 700 real building
   footprints from OpenStreetMap, pulled once from the Overpass API at build time, projected onto
   the scene's compressed bearings, and committed as `wwwroot/data/pocapitol/campus-osm.json`.
   They are instanced off one unit box (four draw calls) and start outside the 150 m radius the
   hand model owns. Data (c) OpenStreetMap contributors, ODbL. A missing file changes nothing.
5. **Reliability and diagnostics (`index.js`, page).** Frame-time p50/p95, frames over 55 ms,
   draw calls, triangles, actor count, footprint count, weather source and the last ten engine
   events are collected in memory and copied with one button. Engine init, context loss, frame
   failure and attempt end are emitted to `window.appInsights` when the host wires it up; the
   ring buffer works without it. Export helpers fall back to `execCommand` where the clipboard
   API is blocked.

Verified with the Node engine tests (`tests/pocapitol-*.test.mjs`, including new report, director and preference suites) and a zero-warning `dotnet build`.

### Gunsmoke and carried signage (2026-11-11, follow-up)

- **Muzzle smoke (`bursts.js`).** Each gunsmoke puff is twice the size and hangs eight times as
  long. A volley now leaves a drifting grey bank along the line instead of a blink, which is the
  point: past a few seconds the far ranks stop reading as people.
- **Carried boards (`wwwroot/data/pocapitol/placards.json`, `signs.js`, `crowd.js`).** Signage is
  data, not code. The national and Gadsden flags stay in the mix; up to fourteen distinct placard
  texts join them per scene, each bearer's board fixed for the attempt by the same stable trait
  that sets their height and build, and one instanced mesh per board so the draw-call count stays
  flat. Across launches the whole list is used.
- **Content.** The shipped list is now short historical signage: one to six words drawn from
  phrases photographed on boards and flags at the Capitol that day, in the owner's chosen set,
  with the in-game notice still marking the scenario as fiction. `signs.js` enforces the
  one-to-six-word budget so a longer line cannot be printed on a board.

## 21. Room scatter, historic signage and concussion grenades (2026-11-11)

Three owner-requested changes. None touches the limits in section 17: still no injury depicted,
no real person, no breach route, no score.

1. **The crowd breaks into rooms (`world.js`).** About one person in three is marked, once, as
   the sort who goes looking through the building; the rest keep pressing the line. Once inside
   (`z < 10`) a marked person leaves the single-file route for a stable anchor in the Crypt, the
   Rotunda or Statuary Hall, then mills there with a slow sway. Anchors sit clear of the columns
   and statues and off the player's centre line. A guard on `support` stops anyone breaking off
   while the next standing line has fewer than eight people on it, so a line is never starved of
   the crowd it needs to give way. Every anchor is checked as walkable by the test suite.
2. **Historic signage (`wwwroot/data/pocapitol/placards.json`, `signs.js`).** The carried boards
   use real, short phrases recorded on signs and flags that day, all within `MAX_WORDS = 6`.
   The scenario remains explicitly fictional and the in-game notice says so.
3. **Concussion grenades (`world.js`, `audio.js`, `bursts.js`, `particles.js`, `decals.js`,
   `scene.js`).** A few people on each side carry three each (raiders `id % 80 === 7`, officers
   `id % 16 === 5`). A carrier lobs one at the nearest opponent within 26 m when it has line of
   sight, on an eleven-to-fourteen second nerve timer. The canister arcs in as a blinking sprite,
   then detonates after 1.4 s: `blastFalloff()` shares the overpressure by the square of distance
   out to 6.5 m, throwing bodies back (`knockback()`), lifting anyone close off their feet
   (`vy` then gravity in `stepContacts`), tumbling them and knocking them down. The room gets a
   bright light, a camera jolt, a shock ring, dust, debris and a large scorch; the sound is a
   synthesized low boom with a pressure tail and a duck.
   **The blast is overpressure, not fragmentation.** Limbs never separate, no wound is drawn and
   there is no blood: the product rules in section 17 make that non-negotiable in every mode.
4. **One-player firepower (`world.js`, `index.js`, page).** A solo raider carries a machine gun
   (`fire()`, about twelve hit-scan rounds a second with a spread that opens as the trigger is
   held), five concussion grenades (**G**) and two smoke grenades (**H**), each thrown toward the
   aim by `throwPlayerGrenade(state, direction, kind)`, with the counts in the Tab panel. Police
   keep batons, spray and their own grenades, so the human is by far the strongest actor.
5. **Smoke grenades (`world.js`, `particles.js`, `bursts.js`, `audio.js`, `scene.js`).** One
   carrier in two on the police side and alternating raider carriers lob a smoke canister instead
   of a blast. It detonates into a `{ type: 'smoke' }` effect: a 7.5 m cloud that lasts 15 s,
   drawn as 26 large slow puffs and matched by a thick local fog while the camera is inside it.
   Sight lines through it are blocked (`smokeObscures()` gates officer targeting and the player's
   machine gun), and anyone inside walks at 60–65% speed. It does no damage.
6. **Bodies can be crossed, not clipped (`world.js`, `crowd.js`).** A living walker that overlaps
   a body on the ground gets a `step` lift so its feet clear the heap and it loses a little pace,
   instead of passing through the mesh; anyone airborne passes over on their own arc. Contact
   separation ignores airborne bodies so a body in flight does not shove people it flies over.
   Gravity is stepped over every body, dead or alive, because the dead are excluded from contact
   resolution and would otherwise hang where a blast left them.
7. **Corpses go slack (`crowd.js`).** The lying pose now blends a limp pass as the collapse
   settles: knees and elbows give, arms splay on the ground, one leg falls open and the head
   lolls to the side, with per-body asymmetry from the body's seed. No gore, no limb separation.
8. **Signage is rarer (`crowd.js`).** One person in twenty carries a board (`id % 20 === 0`),
   down from one in three, so the crowd reads as a crowd and the signs read as signs.
9. **Friendly fire (`world.js`).** A protestor's round resolves against the crowd as well as the
   police: whoever meets the bullet first takes it, and the shooter's own body is skipped. A
   protestor standing in front of an officer now absorbs the round.
10. **The opening volley (`world.js`, `audio.js`, `index.js`).** The first seven seconds of the
    armed demo are calm — the police hold and nobody fires. At seven seconds the line opens up
    (a volley cue and a caption), every protestor panics, runs back from the line for ~1.5 s and
    then those with the nerve fire back.
11. **Close orbit shot (`scene.js`).** The demo camera now cycles three shots every twelve
    seconds: a high crane behind the crowd, a **close orbit around the crowd**, and a shot from
    behind the police line. The orbit walks an 11 m circle at 5.4 m around the crowd's eased
    centroid, with a slow vertical breathe, falling back to 8 m or 14 m where 11 m is blocked, so
    it sweeps past faces, boards and shoving instead of sitting on a crane.

Verified with `tests/pocapitol-graphics.test.mjs` (nine tests covering rooms, blast falloff,
grenade carriers, collision, audio and quality behaviour), the existing room, line and armed-demo
world tests, and a zero-warning `dotnet build`.

## 20. Graphics, audio and physics depth pass (2026-11-11)

Ten owner-selected upgrades across rendering, sound, materials, wear and performance. Every one
builds on a system sections 18 and 19 already shipped rather than replacing it, and none touches
the limits in section 17.

1. **Swept body-vs-body collision (`physics.js`, `world.js`).** Knockback above 2.5 m/s is now
   tested along its whole path, not just at the frame's end point, so a hard shove cannot pass
   through the person it was aimed at. Separation still shares the correction by mass, but the
   two relaxation passes now alternate direction each frame, so the pair that happens to sit
   first in the list no longer wins every contact.
2. **Light-aware post (`post.js`, `scene.js`).** Contact-shadow strength and step scale, SSGI
   bounce strength and radius, SSR intensity, sun-shaft density, bloom threshold and saturation
   now follow the daylight level and whether the camera is inside, so the rotunda's marble reads
   differently from the overcast lawn. Uniforms only: no shader recompiles.
3. **Impact synthesis depth (`audio.js`).** `impactLayers()` adds a sub layer for heavy targets
   and a bright crack for hard blows on top of the existing material modes, so a barricade and a
   person differ even at equal energy. Air absorption now caps the low-pass with distance.
4. **Surface-aware footsteps (`audio.js`).** `footstepMaterial()` picks marble, paving or turf
   from the same coordinates the renderer draws, for the listener and for nearby walkers.
5. **Burst shapes (`bursts.js`).** Ground shockwave rings (flash-bangs, breaking lines, falls) and
   short-lived barrier debris join the existing sprays, puffs and spalls, all still one draw call
   per layer and still a pure function of the shader clock.
6. **UI microinteractions (`ui.js`).** Keyboards get the same dip-and-ripple as pointers, switch
   and radio controls have their own latch cue, and controls lean a few degrees toward a mouse
   cursor. All of it stays off under reduced motion.
7. **Procedural micro-detail (`look.js`).** A second, finer triplanar tap adds height and
   roughness at a smaller scale than the joints, so large stone panels stop reading as smooth
   plastic. Subsurface scattering gains a view-dependent backlight term.
8. **Wear that ages (`decals.js`).** Every mark holds for a while, then thins out, so a long
   session keeps history at the edges of the floor instead of saturating it. Shove streaks now
   point the way the blow travelled.
9. **Glass with edges (`look.js`).** Polycarbonate dispersion is view-dependent and adds a thin
   emissive fringe at grazing angles; the lowest tier falls back to a plain alpha blend instead
   of paying for physical transmission.
10. **Performance and compatibility (`quality.js`, `index.js`).** `detectTier()` reads the actual
    WebGL 2 support, texture limit, memory and core count instead of trusting one of them, a
    stored mode from another build is validated, and a hidden tab suspends the governor so
    throttled frames cannot force a downgrade. `governor.why()` reports the reason for the rung.

Verified with the Node engine tests (`tests/pocapitol-*.test.mjs`, including a new graphics/physics
suite) and a zero-warning `dotnet build`.

## 22. Cleanup, input parity, tabbed options, debrief and blast shadow (2026-11-12)

A five-phase pass over the existing game. Nothing here touches the limits in section 17.

### Cleanup and structure

- The page is split: `PoCapitolPage.razor` is markup and render fragments, and
  `PoCapitolPage.razor.cs` holds state, engine calls and the engine's records.
- Dead engine API removed (`adjustHealth`, `getDebugStats`, `setDirector`, `getReport`,
  `getReportCsv`, `getReportText`, `setTracerMode`, `setMotionReduction`), along with 27 unused
  CSS selectors from the old floating HUD, top bar, bottom bar and bespoke drawer, the unused
  Blender pipeline script, and two hard-coded build strings. Diagnostics now read the app's own
  build stamp.
- The HUD no longer assumes a crowd of 256. The engine reports the crowd's size with every
  update, so the Tab panel, diagnostics and the start card all show the real 512.
- The engine harness in `tests/pocapitol-world.test.mjs` had fallen behind the engine's imports
  and six of its tests could not start. It is repaired.

### Input parity

- Grenades and smoke are no longer keyboard-only. Touch gets two buttons beside FIRE that show
  what is left and disable at zero; a gamepad throws with X and Y. All three paths call the same
  function as G and H.
- The touch button says FIRE for an armed solo raider and PUSH for the police line.
- Tracer style and combat shake are saved with the other comfort settings instead of being lost
  on reload.
- Binding a key that another action already uses swaps the two, so one key can never do two
  things and no action is left without a key.

### Interface

- Scenario options are four tabs (Display, Comfort, Controls, Debrief) instead of one long
  scroll, and the three copies of the graphics picker are one fragment.
- Copy that contradicted the game is corrected: the historical-context text said nobody is armed
  in solo play, while a solo raider carries a machine gun and grenades. Headcounts and the
  control list on the start card now match what the engine does.
- Layout stability: the caption strip stays in the tree while play is live, and the role
  brief, connection status and debrief hold their height, so text arriving late moves nothing.
- On a touchscreen the unit inspector opens at the top instead of on top of the d-pad.

### Debrief

- Every finished attempt gets three plain sentences on the end card and in the Tab panel.
- `debrief.js` is a small inference router. **Built-in** (default) is deterministic, instant
  and never touches the network. **Local model** is opt-in and calls Ollama on the player's own
  machine; it is retried once and then falls back to the built-in writer.
- Under the text is what actually ran: provider, model, tokens per second, token count, time,
  retries, and the reason for any fallback. The same line is in the diagnostics list.
- There is deliberately no cloud provider: the app has no paid AI boundary and this does not
  justify one. Model output is treated as untrusted text: markup stripped, 600 characters at most.

### Bugs found while verifying

- **A holding line could be walked through.** Where a rack is down the crowd presses up to the
  officers; where one stands they stop short of it. Sidestepping from a gap into a standing-rack
  column read as "already past the line", so the human (and the crowd) could walk on while the
  line was still at full integrity. `limitInFront()` now also checks the officers' own line.
- **The options sheet closed itself during play.** Blazor's `SectionOutlet` keys its content on
  the fragment delegate, and `GameShell` handed it a new one every render, so the whole header
  slot was rebuilt five times a second while an attempt ran. `GameShell` now passes one stable
  delegate. This fixes every game's header, not only this one.
- **The solo raider's gunshot was often silent.** Only the last event an action appended was
  sent to the audio layer, and a burst appends a gunshot and then its impact. All of them are
  sent now.
- **Check connection picks a model that exists.** If the model named in the Debrief tab is not
  installed, the first installed one is used and the status line says so. Reasoning models are
  asked not to think (`think: false`), since they otherwise spend the token budget and answer
  with nothing.

### Still open

- `tests/pocapitol-world.test.mjs` "the armed story demo ... ends at the doors" fails on the
  commit before this pass and still fails: the demo now ends after the third line breaks. That
  is the balance question already listed as open question 4, not a regression from this pass.

### Physics

- A concussion blast is now shadowed by walls, pillars and the stands. Anyone without a clear
  line to the blast takes a quarter of the overpressure (`BLAST_SHADOW`), so a grenade in the
  Crypt no longer throws people on the far side of its wall.

Verified with the Node engine tests (`tests/pocapitol-*.test.mjs`, including the new debrief
suite and the repaired engine harness), `scripts/css-lint.ps1`, and a zero-warning build.

## 23. Picture and sound authenticity pass (2026-11-12)

Requested as "more realistic and authentic to January 6". Everything here is presentation: the
simulation, its rules and the limits in section 17 are untouched, and nothing is downloaded or
sampled.

### Sound

- **Voiced chants.** The chant is now ten detuned voices through three formant bands, so each
  beat is a vowel. "U! S! A!" and "Stop the steal!" alternate four rounds at a time, and the back
  of the crowd answers a beat late. The same choir roars when a whole line gives way.
- **The air over the grounds.** A helicopter circles overhead for the whole attempt (faint
  through the roof indoors), hand-held air horns go off in the crowd, and a siren passes on a far
  avenue now and then.
- **Doors.** Glass goes when the Crypt doors line breaks, an extinguisher hisses in each doorway
  that falls, and whichever door the crowd is held at is pounded on for as long as it is held.
- **Curfew alert.** At 2:31 PM on the scenario clock the phones near the listener sound an
  emergency-alert tone, slightly out of time with each other, with the caption "Emergency alert:
  citywide curfew from 6:00 PM." The 6 pm curfew order is history; the minute the tone is heard
  in the game is approximate.

### Picture

- **Footage look.** A new option, Options -> Picture & sound, with three values: Phone footage,
  Light (default) and Clean. Light keeps about a third of the picture treatment and leaves the
  sound clean. Phone footage adds a wider lens bow, a sharpening halo, streaks off bright
  lights, a sky that clips early, lifted shadows, heavier sensor noise, exposure that dips after a
  flash-bang, and a handheld sway. Reduced motion and reduced flashing switch off the sway and the
  noise. Phone footage also routes sound through a phone microphone: no low end, a limiter that
  pumps after every bang, and wind on the capsule outdoors. Stored as `footage` in
  `pocapitol.prefs.v1`.
- **Haze and extinguishers.** Gas and smoke now leave a low haze that hangs for about fifty
  seconds and slides off with the wind. When a doorway line breaks, two dry-powder extinguisher
  clouds are let off in the opening. Both are clouds only; nothing in the simulation reads them.
- **Kit.** About one officer in three wears a gas mask, as do a few in the crowd. Some of the
  crowd wear a flag as a cape.
- **What is left behind.** Water bottles and dropped flags appear behind each line once it has
  fallen, indoors and out.
- **Dusk.** Work lights on the inauguration scaffold come on as the light goes.

### Bug found while verifying

- The spectator camera's phone cut was meant to last six seconds. Once its cooldown had expired it
  re-armed itself every frame, so a subject who kept filming held the phone view indefinitely.
  It now lasts six seconds.

### Already present, so not rebuilt

The request's list also named the afternoon-to-dusk light, mixed police kit, winter dress, the
press tower and "AREA CLOSED" boards. Those were already in the game and were left as they were.

Verified with `tests/pocapitol-graphics.test.mjs` and `tests/pocapitol-prefs.test.mjs` (31 pass,
five of them new), a zero-warning build,
chant, roar, helicopter and air-horn levels cut by about a third at the owner's request, and the demo and solo play in headless Chromium with no
shader or script errors. The sound was not listened to by a person in this pass; levels are set
by calculation and may want trimming by ear. Before and after:
`SCREENSHOTS/261112-pocapitol-realism.png`.
