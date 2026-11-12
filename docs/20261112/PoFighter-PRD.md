# PoFighter — Product Requirements Document

Status: Draft for approval, 2026-11-12. Covers the first milestone (one fighter in a practice
room). This document contains product requirements only, not technical architecture.

## 1. Executive summary and vision

**Problem.** Fighting games are fun to play but their characters are strangers. Making a
fighter out of a real person normally needs artists, animators and weeks of work.

**Solution.** PoFighter is a one-on-one, side-view fighting game whose fighters are real
people. A person is filmed doing the basic moves (stance, walk, crouch, jump, punch, kick).
The moves are found in that video and turned into the fighter's animations. The game then
plays those animations in response to the player's controls.

**Value.** A short phone video becomes a playable fighter. Family and friends can see
themselves in a game, and each new video adds a new character.

**First milestone.** One fighter, made from one video, in a practice room where every move
can be tried and judged. Nothing else is built until the owner is satisfied with this fighter.

**Originality.** PoFighter is an original game in the one-on-one fighting genre. It does not
reuse the characters, names, stages, music or screen design of any existing fighting game.

## 2. Personas and target segments

| Persona | Goal | Pain point | Motivation |
|---|---|---|---|
| **The owner / director** (films people, reviews the result) | Turn a video into a fighter that moves convincingly | Cannot tell whether a video is good enough until the moves are seen in the game | Wants to approve one fighter before filming more |
| **The performer** (the person in the video) | Appear in the game looking like themselves | Has no control over how they are shown | Wants a flattering, recognisable result and a say in being published |
| **The hub visitor** (anyone on the public site) | Try a new game quickly | Unfinished games feel broken | Curiosity; wants to press buttons and see a real person fight |

## 3. Epics and prioritised user stories

Priority: **P0** must be in the first milestone, **P1** should be, **P2** is later.

### Epic A — Turn a video into a fighter

**A1 (P0).** As the owner, I want the moves in my video found for me, so that I do not have
to mark timestamps by hand.
- Each required move (section 7) is matched to a stretch of the video, or reported as missing.
- The owner is shown a summary: move name, where it was found, and how many pictures it has.

**A2 (P0).** As the owner, I want the performer cut out from the room, so that the fighter
can stand on any stage.
- No part of the room, furniture or the performer's shadow appears around the fighter.
- No other person from the video appears in any picture.
- The performer's whole body, including feet, is present in every picture used.

**A3 (P0).** As the owner, I want to review the extracted moves on one page before they go
into the game, so that I can reject a bad cut-out early.
- The page shows every move as a strip of its pictures, in order.
- The owner approves or rejects the set as a whole.

**A4 (P1).** As the owner, I want a missing move to fall back to the neutral stance, so that
the game is playable before I film more.
- A missing move shows the neutral stance and is listed as "missing" in the practice room.

**A5 (P2).** As the owner, I want a shot list and filming tips, so that my next video gives
cleaner results.

### Epic B — Practice room

**B1 (P0).** As a player, I want to move my fighter with every control, so that I can test
all the movements.
- Walk forward, walk backward, crouch, jump, mid punch, high punch and kick each respond to
  their control and play their own animation.
- Releasing all controls returns the fighter to the idle stance.

**B2 (P0).** As a player, I want a dummy to hit, so that I can see whether attacks connect.
- A stationary dummy stands in the room.
- An attack that reaches the dummy produces a visible flash and raises a hit counter.
- An attack that does not reach the dummy does neither.

**B3 (P0).** As a player, I want the list of moves and their controls on screen, so that I
do not have to guess.
- Every move is listed with its control for the device in use.
- The move being performed is highlighted while it plays.

**B4 (P1).** As a player, I want to play with keyboard, gamepad or touch, so that it works
on a laptop and a phone.
- All moves in B1 are reachable on each of the three.

**B5 (P1).** As a player, I want to reset the room, so that I can start a test again.
- Reset returns the fighter to the start position and the hit counter to zero.

**B6 (P1).** As the owner, I want to step through a move one picture at a time, so that I
can judge its quality.
- A slow-motion or step control shows a chosen move picture by picture.

### Epic C — On the hub

**C1 (P0).** As a hub visitor, I want to find PoFighter on the home page marked as a
preview, so that I know it is unfinished.
- PoFighter has its own card, with the practice room labelled as a preview.

**C2 (P1).** As a hub visitor, I want a start card that explains the controls, so that I can
begin without reading a manual.

### Epic D — Later versions (P2, not in this milestone)

- **D1.** Matches: health, rounds, a timer, a winner.
- **D2.** A computer opponent, and a second local player.
- **D3.** More fighters, each from their own video, and a fighter select screen.
- **D4.** Real block, hit reaction, knockdown and victory animations.
- **D5.** Scores and leaderboards.

## 4. Core workflows and states

### 4.1 Making a fighter

1. **Video supplied** — the owner provides a video of one performer.
2. **Moves found** — each required move is matched to a stretch of video, or marked missing.
3. **Performer cut out** — the performer is separated from the room in every chosen picture.
4. **Review** — the owner sees every move on one page.
   - Approved → step 5.
   - Rejected → back to step 2 with the owner's notes, or a new video.
5. **Fighter published** — the fighter is playable in the practice room.

### 4.2 Fighter states in the practice room

| State | Entered when | Leaves when |
|---|---|---|
| Idle | No control held, on the ground | Any control is used |
| Walking forward / backward | Direction held, on the ground | Direction released, or another move starts |
| Crouching | Down held, on the ground | Down released |
| Jumping | Up pressed, on the ground | The fighter lands |
| Attacking (mid punch, high punch, kick) | Attack pressed, on the ground, not already attacking | The attack animation ends |

Rules that tie the states together:

- An attack always plays to the end; it cannot be cancelled by walking or by another attack.
- A jump always completes; the fighter cannot attack or change direction in the air in this
  milestone.
- The fighter cannot walk while crouching or attacking.
- The dummy has two states: **standing** and **just hit** (a short flash), then standing again.

### 4.3 Practice session

Open the game → start card with controls → practice room → (reset at any time) → leave to
the hub. There is no win, loss or end screen.

## 5. Scope

| In scope for this milestone | Out of scope for this milestone |
|---|---|
| One fighter from the one supplied video | Further fighters and fighter select |
| Idle, walk forward, walk backward, crouch, jump, mid punch, high punch, kick | Block, hit reaction, knockdown, victory (neutral stance stands in) |
| Practice room with a stationary dummy, hit flash and hit counter | Health bars, rounds, timer, winner |
| On-screen move list; reset; step-through of a move | Computer opponent, second player, online play |
| Keyboard, gamepad and touch controls | Scores, leaderboards, saved progress |
| One simple original stage | Multiple stages, music, announcer |
| Hub card labelled as a preview | Crouching attacks, jumping attacks, special moves, combos |
| Review page for extracted moves | Players uploading their own videos |

## 6. Business rules and data invariants

**Likeness and privacy**

1. A fighter is published only when its performer has agreed to appear in a public game.
2. Only the performer appears. Any other person in the video is removed from every picture.
3. The original video is never published; only the cut-out pictures of the performer are.
4. A fighter must be removable on request, leaving the game working without it.

**Fighter completeness**

5. A fighter must have an idle stance. Without it the fighter cannot be published.
6. Every other move is optional. A missing move shows the idle stance and is labelled missing.
7. Walking backward may reuse the walking-forward pictures played in reverse.
8. The fighter always faces the dummy. The source pictures face one way and are mirrored
   when the fighter is on the other side.
9. All pictures of one fighter share one scale and one ground line, so the fighter does not
   grow, shrink or float between moves.

**Practice room**

10. The fighter cannot leave the visible room, and cannot walk through the dummy.
11. One attack can register at most one hit on the dummy.
12. An attack registers a hit only during the part of the animation where the arm or leg is
    extended, and only when it reaches the dummy.
13. The hit counter never goes below zero and resets only on reset or on leaving the room.
14. The dummy never moves, attacks or falls.
15. Nothing done in the practice room is scored, saved or sent anywhere.

**Edge cases**

- Two attack controls pressed together: the first one registered plays; the other is ignored.
- Opposite directions held together: the fighter stays idle.
- Jump and attack pressed together on the ground: the jump wins.
- The game loses focus (tab hidden, phone locked): the room pauses and resumes on return.
- A device with no keyboard or gamepad shows touch controls automatically.

## 7. What the supplied video contains

Source: one 29-second video, one performer in side view facing right.

| Move | Found | Note |
|---|---|---|
| Idle stance | Yes | Many pictures |
| Walk forward | Partly | Short shuffles, not a clean walk |
| Walk backward | No | Will reuse walk forward in reverse |
| Crouch | Yes | Brief |
| Jump | Yes | Some motion blur |
| Mid punch, high punch | Yes | Several of each |
| Kick | Yes | About five front kicks |
| Block, hit reaction, knockdown, victory | No | Neutral stance stands in |

Known quality risks: the performer wears grey against a grey wall with a strong shadow, so
cut-out edges may be rough; feet are hidden in some early pictures; a second person is
visible at the lower left and must be removed.
