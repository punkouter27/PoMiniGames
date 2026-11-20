# PoEcosystem tools

Node tools for PoEcosystem's assets and checks. None of them is part of the app build: each
writes files the client ships, or checks code the client runs, and is run by hand when its
source changes. They have no `node_modules` of their own; the two that need packages use
PoCabinet's (`npm ci --prefix scripts/pocabinet`, once).

| Script | What it does | Run it after |
|---|---|---|
| `creatures.mjs` | Authors the four creature models (a skeleton, a body of tapered prisms, clips written as functions of the cycle) and writes them as skinned, animated glTF: `wwwroot/models/poecosystem/{rabbit,deer,wolf,human}.glb`. No packages needed. | changing a model or a clip in the script |
| `voices.mjs` | Voices every creature thought (`sim/thoughts/templates.js`) and narrator line (`render/chronicle.js` `NARRATION`) once, with a local text-to-speech model (Kokoro-82M through `kokoro-js`), into `wwwroot/audio/poecosystem/`. Needs ffmpeg on PATH. | editing a thought or a narrator line |
| `physics-check.mjs` | Runs the island's Rapier physics (`sim/physics/rapierWorld.js`) on a real island in node and checks it: the heightfield is the right way round, ragdolls, felled trees and rockslides land on the ground and settle, an explosion moves what is near it, props survive a save. | changing `rapierWorld.js` or the island generator |

```powershell
node scripts/poecosystem/creatures.mjs            # write the models
node scripts/poecosystem/creatures.mjs --check    # exit 1 if a model on disk is not what the script makes
node scripts/poecosystem/voices.mjs               # voice whatever has no clip yet
node scripts/poecosystem/voices.mjs --check       # no model: list lines with no clip, exit 1 if any
node scripts/poecosystem/physics-check.mjs        # seven checks, exit 1 if any fails
```

## The creature models

The game loads each `.glb` with three's `GLTFLoader` and bakes its clips into a bone-matrix
texture (`render/creatureModels.js`), so the files are ordinary glTF and can be opened in any
viewer. A hand-made model can replace one of them as long as it keeps:

- a skinned mesh (vertex colours are used; textures are not), feet on `y = 0`, `+Z` forward,
  at the size of the box rig it replaces (`render/creatureMeshes.js` `RIGS`);
- clips named `idle`, `walk`, `run`, `feed`, `rest` (and `work` for the human), all looping;
- `asset.extras.poecosystem.clips.{walk,run}` = `{ stride, cadence }`: metres of ground per
  cycle at model scale, and the most cycles a second the legs may turn over.

Each vertex follows the joint it is weighted to most, so a smooth-skinned model creases at
its joints. A model that will not load leaves that species on its box rig.

A dead creature is drawn as the same model with each joint carried by one part of its
physics ragdoll (`sim/physics/ragdoll.js` `RIGS`). Joints are matched to parts by name:
`fl`, `fr`, `bl`, `br` (then `_` and anything) are the four legs, `head`, `neck` and `ear*`
the head, and everything else the torso; for the human, `armL`/`armR`/`legL`/`legR`, `head`,
`chest`, and everything else the pelvis. A model with other joint names still loads, and its
body moves as one piece with the torso.

## The voices

Thoughts and narration are recordings: nothing is generated in the browser or on the server.
A clip's file name is a hash of its voice, speed and text, so a reworded line gets a new file
and the old one is deleted on the next run. Until the script has been run, a new line is shown
and not spoken.
