# PoMule: ten ways to be more like the 1983 original

**Date:** 2026-11-17 · **Scope:** `src/PoMiniGames.Shared/Games/PoMule` and
`src/PoMiniGames.Client/Features/PoMule` · **Status:** proposal, nothing implemented.

PoMule is a close rules clone of _M.U.L.E._ (Ozark Softscape / Electronic Arts, 1983): the same four
goods, the same spoilage (half of spare Food, a quarter of spare Energy, a 50-unit ore warehouse),
the same one-highlighter land grant, the same walking-floor market with the Store as the counterparty,
the same wumpus, pub, assay office and event table. What differs is the **shape of the game** — sixteen
colonists where the original had four, one human where the original had up to four — and a handful of
rules that got smoothed over while scaling up.

Each item below states what the original does, what PoMule does today (with the file and line), and
the smallest change that would close the gap. Items are ordered by how much they change the feel.

---

## 1. Four colonists, and 2–4 humans at one machine

**Original.** Four colonists. "Four humans can play. If you have less than four humans, the computer
will play the others." The negotiation, the bidding wars and the ganging-up on the leader are the
game; every screen is built to be watched by four people at once.

**PoMule.** `PoMuleTuning.Seats = 16`
([PoMuleTuning.cs:10](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleTuning.cs:10)): "the player and
fifteen AI". Exactly one seat is `Archetype.Human` — seat 0, inserted in `MatchState.New`. Every
human-facing method on `PoMuleMatch` is hard-wired to that seat (`PickLand`, `BuyMule`, `Outfit`,
`Install`, `Survey`, `HumanPub`, `SetRole`, `HumanMarketInput`), and the client renders one input path
and one HUD.

**Smallest faithful change.** Support 2–4 human seats chosen on the intro card, each with its own
input channel. The engine is already per-seat (`IsAi(seat)`, per-seat `LaneRole`/`LanePrice`/`Goals`),
so this is plumbing: seat-parameterised commands, a per-seat control map on the client, and four lanes
on the floor instead of sixteen.

**Ripple risk (highest in this list).** The action log and `PoMuleRunVerifier` are seat-0 implicit
(`PoMuleCommand` letters carry no seat for Buy/Outfit/Install/Pub/Role), `SnapshotHeader`/
`SnapshotPerSeat` is a fixed interop layout, and `PoMuleHighScore` is a single-player board.

---

## 2. Shrink the planet so land is scarce

**Original.** A small map you can read at a glance; the free plot each turn is a real decision and
contested plots are common ("if two players choose the same spot, the player with less money wins").

**PoMule.** A 24×9 planet, 212 non-town plots for sixteen colonists
([PoMuleMap.cs](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleMap.cs)). Sixteen grants a month for
twelve months is 192 plots, plus six auctions of two, so the board is effectively consumed by month
11 and `Begin` starts skipping the Land phase (`if (!... Any(Claimable)) Go(Phase.Development)`).
The species roster is dealt twice over — each of the eight species appears twice — so nothing is
unique and the species pick is a preference, not a draft.

**Smallest faithful change.** Size the map and the seat count together: a four-colonist colony on a
map with roughly one plot per colonist-turn, one unique species each. Add a "Colony" (16-seat) preset
if the big match should survive as its own mode.

---

## 3. Land auctions every turn, and owners can sell their plots

**Original.** In Standard, "the store auctions land immediately after each Land Grant", one plot at a
time. In Tournament you may put any of your own plots up for sale.

**PoMule.** Auctions run only on even months
([PoMuleLand.cs:68](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleLand.cs:68),
`PoMuleTuning.AuctionPlotsPerEvenMonth = 2`) and only ever for unclaimed land
(`PickAuctionPlots` filters on `Claimable`). An owned plot can never change hands.

**Smallest faithful change.** Make the auction cadence a rules knob (every month in Standard), and
let a seat nominate one of its own plots for the block. The auction floor already exists; it needs a
seller and a payout instead of "winner pays nobody".

---

## 4. Private deals between colonists

**Original.** Two players may agree a price off-floor for goods or land — the "make a deal" screen.
StrategyWiki lists private trades and collusion as Tournament rules; it is the most-remembered screen
in the game.

**PoMule.** Only the public floor ([PoMuleMarket.cs](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleMarket.cs)).
No offer, no accept, no way to help or extort a specific rival.

**Smallest faithful change.** An `Offer(seat, target, goodOrPlot, quantity, price)` / `Accept`
command pair resolved at the end of the development phase, logged in the replay, and refused between
AI seats unless a human is party to it. This is also the natural home for "sell my plot" from item 3.

---

## 5. A real rules ladder: Beginner / Standard / Tournament

**Original.**

| Mode | Turns | Land | M.U.L.E. price | M.U.L.E.s | Selling below need | Plots sellable |
| --- | --- | --- | --- | --- | --- | --- |
| Beginner | 6 | grants only, no auctions | fixed | never run away | no | no |
| Standard | 12 | grant + auction every turn | moves with smithore | bolt if not installed on the house icon | yes | no |
| Tournament | 12 | grant + auction every turn | moves with smithore | same | yes | yes |

The colony must be worth $60,000 in Standard, or everyone is sent home.

**PoMule.** One match length (`PoMuleTuning.Months = 12`, [PoMuleTuning.cs:11](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleTuning.cs:11)),
one auction cadence, one sell rule, and a single "Classic 1983 rules" checkbox that does something
else entirely (item 6).

**Smallest faithful change.** A `RuleSet` enum in `PoMuleTuning` that flips the constants already
listed there: `Months`, the auction cadence, whether the M.U.L.E. price is fixed or derived, whether
`Bump` can make a M.U.L.E. bolt, whether `Surplus` may go negative, and whether owned plots can be
nominated. The intro card then offers three buttons instead of a checkbox.

---

## 6. Species traits are always on — the "Classic" switch is inverted

**Original.** Species traits are not a variant; they are the roster. The 1983 Beginner game removed
turns, auctions and M.U.L.E. prices, never the species.

**PoMule.** `MatchState.Classic` is documented as "Classic 1983 rules: no species traits, only the
Flapper's and the Humanoid's purses differ"
([PoMuleState.cs](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleState.cs)), and `StartingCash`
flattens every other species to 1,000 under it. So the mode named after the original removes the one
thing the original never removed.

**Smallest faithful change.** Delete the traits-off branch; keep the trait differences in every mode.
Era differences belong in the ladder (item 5).

---

## 7. Put crystite back in the jackpot business

**Original.** Crystite is hidden, assayed at the office, and "the big earner that can make or break
your game" — the final auction's crystite price is what decides whether the colony survives.

**PoMule.** Crystite price is a random 50–150 each month and the cap is 150
([PoMuleTuning.cs:90](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleTuning.cs:90)); the plot
`Crystite` field claims a 0–4 scale but generation only ever produces 0 (plains/mountains) or 1–3
(craters), so a rich vein does not exist. A good crystite month is roughly one and a half times a
good food month, not a lottery ticket.

**Smallest faithful change.** Seed a few 4s, let the price climb into the hundreds in the late
months (a much higher `PriceMax` for Crystite, or a month-scaled ceiling), and make the final market
of month 12 a distinct settlement step so the ship's arrival reads as the payoff it was.

---

## 8. Make installing a M.U.L.E. a skill test

**Original.** The M.U.L.E. must be installed on the plot's house icon. Miss, and it runs away with
your money. In Beginner it never runs away.

**PoMule.** `Install` checks ownership only
([PoMuleDevelopment.cs:81](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleDevelopment.cs:81)): on
your own land, anywhere on the plot works; on someone else's, it bolts.

**Smallest faithful change.** One install point per plot, a tolerance in the renderer's arrival check,
and `Outcome.Runaway` when the colonist drops the tether outside it. The bolt outcome, notice and
audio already exist.

---

## 9. Scale the Federation bar per colonist

**Original.** $60,000 of colony net worth for four colonists — 15,000 each — and money is the only
failing grade. Shortage of Food costs you time, not the game.

**PoMule.** `FederationTarget = 120_000`
([PoMuleTuning.cs:118](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleTuning.cs:118)) for sixteen
seats — 7,500 each, half the pressure — and `ColonySurvives` also fails the colony on
`CrisisMonths > MaxCrisisMonths`
([PoMuleScoring.cs:42](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleScoring.cs:42)), a condition
the original does not have.

**Smallest faithful change.** Express the target per colonist (15,000 × seats, so 60,000 at four) and
make crisis months flavour, not a loss condition — or keep it only as a Beginner-mode mercy rule.

---

## 10. Let the trading floor run until it clears, and show the price board

**Original.** The auction phase lasts as long as players keep working the floor, and the Store screen
shows every good's price history — that board is the planning tool the whole game is built around.

**PoMule.** Each good gets a hard 12 seconds (`PoMuleTuning.MarketSeconds`), with an AI-only quiet
skip (`MarketQuietTicks`) that never applies while a human is bidding. The Store keeps one price per
good — `StoreState` is `Stock` + `Price` only
([PoMuleState.cs:38](../../src/PoMiniGames.Shared/Games/PoMule/PoMuleState.cs:38)) — and the monthly
`History` array holds net worth, not prices. So there is nothing to plan against.

**Smallest faithful change.** End a good when the floor is quiet for both humans and AI, not on a
fixed bell; record `Store.Price` per good per month in `History` and draw it beside the standings
chart.

---

## Proposed order

**Phase A — tuning size, keeps sixteen seats, no replay or client contract changes.**
Items 6, 9, 7, 10, 3 (cadence knob only), 8. All are constants, one condition, or one field. Check
them with the existing 100-match balance run plus the PoMule unit area.

**Phase B — variants.** Item 5's rules presets (built on the Phase A knobs), then item 4's private
deals. Deals need new replay commands, so doing them before Phase C means the replay format only
changes once.

**Phase C — the structural pair.** Items 1 and 2 together: seat count, map size, species draft,
multi-human input, HUD lanes, and the replay-command seat field. This is where `PoMuleRunVerifier`,
`PoMuleHighScore`, the client input path, and the tier test ceilings all get touched.

## Sources for the original's rules

- M.U.L.E. game manual (Beginner/Standard/Tournament tables, $60,000 colony target, land auction
  after each grant, house-icon install).
- StrategyWiki, _M.U.L.E./Gameplay_ and _M.U.L.E./Phase III: The auction_ (6 vs 12 turns, plot sales,
  private trades, spoilage).
- MobyGames and the Internet Archive entry for the 1983 release (four colonists, 1–4 humans, the
  lower-cash player winning a contested plot, crystite as the swing commodity).
