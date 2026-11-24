namespace PoMiniGames.Shared.Games.PoMule;

public enum GoalKind : byte { Idle, Outfitter, Install, Assay, Survey, Pub, Chase }

/// <summary>What a colonist is working toward over the coming months; it picks the plan's flavour.</summary>
public enum Objective : byte { SecureFood, SecureEnergy, MineSmithore, MineCrystite, CornerScarce, CashOut }

/// <summary>One step of a colonist's plan: outfit for <paramref name="Good"/>, install on <paramref name="Plot"/>, or head for the pub.</summary>
public readonly record struct PlanStep(GoalKind Kind, int Plot, Good Good);

/// <summary>What a trader expects of one good next month: a smoothed Store price, and whether supply is forecast to fall short.</summary>
public readonly record struct Forecast(int Price, bool Scarce);

/// <summary>
/// Where an AI colonist is heading during development. The renderer steers the avatar there
/// and reports the arrival; the engine then performs (and re-checks) the action.
/// </summary>
/// <param name="Target">
/// A plot for <see cref="GoalKind.Install"/> and <see cref="GoalKind.Survey"/>; a seat for
/// <see cref="GoalKind.Chase"/> (-1 = loiter at a town door); otherwise -1, meaning the
/// nearest town.
/// </param>
/// <param name="Good">What to outfit or install.</param>
public readonly record struct Goal(GoalKind Kind, int Target, Good Good);

/// <summary>
/// The seven computer personalities. Hand-written rules, like every other opponent in
/// PoMiniGames; each method reads the match and answers one question, keeping nothing
/// between calls.
/// </summary>
public static class PoMuleAi
{
    // Terrain appeal by personality: Plains, River, Mountain, Crater. (Mountains add 20 a peak.)
    private static int Appeal(Archetype archetype, Terrain terrain) => (archetype, terrain) switch
    {
        (Archetype.Farmer or Archetype.Hoarder or Archetype.Speculator, Terrain.River) => 100,
        (Archetype.Farmer or Archetype.Hoarder or Archetype.Speculator, Terrain.Plains) => 50,
        (Archetype.Industrialist, Terrain.Mountain) => 60,
        (Archetype.Prospector, Terrain.Crater) => 110,
        (Archetype.Prospector, Terrain.Mountain) => 25,
        (Archetype.Speculator, Terrain.Crater) => 68,
        (Archetype.Agitator or Archetype.Gambler, Terrain.River or Terrain.Plains) => 50,
        _ => 20,
    };

    /// <summary>The plot this colonist points its land-grant cursor at.</summary>
    /// <param name="from">Only plots the highlighter has not passed yet (index at or after this).</param>
    public static int PickLand(MatchState match, int seat, int from = 0)
    {
        var archetype = match.Players[seat].Archetype;
        var objective = ChooseObjective(match, seat);
        var best = -1;
        var bestScore = int.MinValue;
        for (var i = Math.Max(0, from); i < match.Owner.Length; i++)
        {
            if (!PoMuleLand.Claimable(match, i)) continue;
            var plot = match.Map.Plots[i];
            var score = Appeal(archetype, plot.Terrain) - TownDistance(i) + match.Rng.Next(8) + LandGoalBonus(match, seat, objective, i);
            if (archetype == Archetype.Industrialist) score += 20 * plot.Peaks;
            // Everybody can read the Store's board: the dearer Smithore is (the emptier the
            // corral), the better a mountain looks, whoever you are.
            if (plot.Terrain == Terrain.Mountain)
                score += PoMuleProduction.BaseYield(plot, Good.Smithore) * match.Store.Price[(int)Good.Smithore] / PoMuleTuning.OreAppealDivisor;
            if (archetype == Archetype.Prospector && PoMuleDevelopment.CanSeeCrystite(match, seat, i)) score += 30 * plot.Crystite;
            if (score > bestScore) (best, bestScore) = (i, score);
        }
        return best;
    }

    private static int TownDistance(int plot)
    {
        var (column, row) = (plot % PoMuleMap.Columns, plot / PoMuleMap.Columns);
        return PoMuleMap.TownColumns.Min(t => PoMuleMap.ColumnDistance(t, column)) + Math.Abs(row - PoMuleMap.TownRow);
    }

    /// <summary>Crystite a M.U.L.E. would dig here as far as this colonist can tell: craters are a good bet.</summary>
    private static int ExpectedYield(MatchState match, int seat, int plot, Good good)
    {
        var tile = match.Map.Plots[plot];
        if (good == Good.Crystite && !PoMuleDevelopment.CanSeeCrystite(match, seat, plot))
            return tile.Terrain == Terrain.Crater ? 2 : 0;
        return PoMuleProduction.BaseYield(tile, good);
    }

    private static IEnumerable<int> Plots(MatchState match, int seat) =>
        Enumerable.Range(0, match.Owner.Length).Where(i => match.Owner[i] == seat);

    // ── Objectives and plans (GOAP-lite) ──
    // Nothing is stored between calls: the objective and the plan are re-derived from the match
    // every time, so a plot that gets taken, a purse that runs dry or a goal that is met simply
    // yields a different plan on the next call. That keeps it deterministic and save-safe.

    private const int Never = -1_000_000;

    /// <summary>What this colonist's M.U.L.E.s already add up to: units made per good, and how many burn Energy.</summary>
    private sealed record Ledger(int[] Making, int Drawing)
    {
        public Ledger With(Plot plot, Good good)
        {
            var making = (int[])Making.Clone();
            making[(int)good] += PoMuleProduction.BaseYield(plot, good);
            return new Ledger(making, Drawing + (good == Good.Energy ? 0 : 1));
        }
    }

    private static Ledger BuildLedger(MatchState match, int seat)
    {
        var making = new int[4];
        var drawing = 0;
        foreach (var i in Plots(match, seat))
        {
            if (match.Installed[i] == MatchState.Nobody) continue;
            var good = (Good)match.Installed[i];
            making[(int)good] += PoMuleProduction.BaseYield(match.Map.Plots[i], good);
            if (good != Good.Energy) drawing++;
        }
        return new Ledger(making, drawing);
    }

    /// <summary>Miners, and the two carefree personalities, live off their stock and only farm when it runs low.</summary>
    private static bool LivesOffStock(PlayerState player) => player.Archetype is Archetype.Industrialist or Archetype.Prospector or Archetype.Gambler or Archetype.Agitator;

    /// <summary>
    /// The goal this colonist is working toward, chosen from its state: keep the lights on, keep
    /// everyone fed, then whatever its personality (or, for the generalists, its species) fancies.
    /// </summary>
    public static Objective ChooseObjective(MatchState match, int seat)
    {
        var player = match.Players[seat];
        var ledger = BuildLedger(match, seat);

        // Nobody runs M.U.L.E.s they cannot power: Energy output must cover the next one too,
        // unless there is a couple of months of it in stock.
        var drawing = ledger.Drawing + 1;
        if (ledger.Making[(int)Good.Energy] < drawing && player.Goods[(int)Good.Energy] < drawing * 2) return Objective.SecureEnergy;

        var need = PoMuleTuning.FoodNeed(match.Month + 1);
        var foodShort = LivesOffStock(player)
            ? player.Goods[(int)Good.Food] + ledger.Making[(int)Good.Food] < need
            : ledger.Making[(int)Good.Food] < need;
        if (foodShort) return Objective.SecureFood;

        if (match.Month >= PoMuleTuning.Months - 1) return Objective.CashOut;

        return player.Archetype switch
        {
            Archetype.Industrialist => Objective.MineSmithore,
            Archetype.Prospector => Objective.MineCrystite,
            Archetype.Farmer => Objective.SecureFood,
            Archetype.Hoarder => Objective.CornerScarce,
            _ => SpeciesObjective(match, player, player.Archetype == Archetype.Speculator ? Objective.CornerScarce : Objective.CashOut),
        };
    }

    /// <summary>The generalists lean on what their species is good at.</summary>
    private static Objective SpeciesObjective(MatchState match, PlayerState player, Objective fallback)
    {
        if (match.Has(player, Species.Gollumoid)) return Objective.SecureFood;
        if (match.Has(player, Species.OreGorger)) return Objective.MineSmithore;
        if (match.Has(player, Species.CrystiteWeaver)) return Objective.MineCrystite;
        if (match.Has(player, Species.Voltronix)) return Objective.CornerScarce;
        return fallback;
    }

    private static IEnumerable<int> Neighbours(int plot)
    {
        var (column, row) = (plot % PoMuleMap.Columns, plot - plot % PoMuleMap.Columns);
        yield return row + (column + 1) % PoMuleMap.Columns;
        yield return row + (column + PoMuleMap.Columns - 1) % PoMuleMap.Columns;
        if (plot >= PoMuleMap.Columns) yield return plot - PoMuleMap.Columns;
        if (plot + PoMuleMap.Columns < PoMuleMap.Columns * PoMuleMap.Rows) yield return plot + PoMuleMap.Columns;
    }

    private static int LandGoalBonus(MatchState match, int seat, Objective objective, int index)
    {
        var plot = match.Map.Plots[index];
        var bonus = objective switch
        {
            Objective.SecureFood => 6 * PoMuleProduction.BaseYield(plot, Good.Food),
            Objective.SecureEnergy => 6 * PoMuleProduction.BaseYield(plot, Good.Energy),
            Objective.MineSmithore => 8 * PoMuleProduction.BaseYield(plot, Good.Smithore),
            Objective.MineCrystite => 8 * ExpectedYield(match, seat, index, Good.Crystite),
            _ => 0,
        };
        // Plots beside its own make bigger economies of scale: a cluster beats a scatter.
        foreach (var n in Neighbours(index))
            if (objective is Objective.MineSmithore or Objective.MineCrystite && n < match.Owner.Length && match.Owner[n] == seat) bonus += 3;
        return bonus;
    }

    /// <summary>Same-good M.U.L.E.s beside this plot (installed, or the one just planned).</summary>
    private static int ClusterSize(MatchState match, int seat, int plot, Good good, int plannedPlot, Good plannedGood)
    {
        var count = 0;
        foreach (var n in Neighbours(plot))
        {
            if (n >= match.Owner.Length) continue;
            if (match.Owner[n] == seat && match.Installed[n] == (sbyte)good) count++;
            else if (n == plannedPlot && plannedGood == good) count++;
        }
        return count;
    }

    /// <summary>Score of outfitting for <paramref name="good"/> and installing on <paramref name="plot"/>, per month; <see cref="Never"/> when it cannot work.</summary>
    private static int Utility(MatchState match, int seat, Objective objective, int[] prices, Ledger ledger,
        int plot, Good good, int plannedPlot = -1, Good plannedGood = default)
    {
        var player = match.Players[seat];
        var yield = ExpectedYield(match, seat, plot, good);
        if (yield <= 0) return Never;

        var drawing = ledger.Drawing + (good == Good.Energy ? 0 : 1);
        var energyShort = ledger.Making[(int)Good.Energy] < drawing && player.Goods[(int)Good.Energy] < drawing * 2;
        if (good != Good.Energy && energyShort) return Never / 2;

        var score = yield * prices[(int)good];
        if (good == Good.Energy && ledger.Making[(int)Good.Energy] < ledger.Drawing + 1 && player.Goods[(int)Good.Energy] < (ledger.Drawing + 1) * 2)
            score += 400;

        var foodShort = ledger.Making[(int)Good.Food] < PoMuleTuning.FoodNeed(match.Month + 1);
        if (good == Good.Food && yield >= 2 && foodShort && (!LivesOffStock(player) || objective == Objective.SecureFood)) score += 300;

        if (objective != Objective.CashOut)
        {
            score += (objective, good) switch
            {
                (Objective.SecureFood, Good.Food) => 200,
                (Objective.MineSmithore, Good.Smithore) => 200,
                (Objective.MineCrystite, Good.Crystite) => 200,
                (Objective.CornerScarce, _) when ExpectedShort(match, good) => 100 + 20 * yield,
                _ => 0,
            };
            if (objective is Objective.MineSmithore or Objective.MineCrystite)
                score += 8 * ClusterSize(match, seat, plot, good, plannedPlot, plannedGood);
        }
        return score;
    }

    private static int[] ForecastPrices(MatchState match) =>
        [.. Enumerable.Range(0, 4).Select(g => ForecastFor(match, (Good)g).Price)];

    /// <summary>
    /// This colonist's next few months of development as steps: outfit and install (up to two
    /// M.U.L.E.s, chosen together by a two-step look-ahead over cost and benefit), or just the pub when
    /// buying one would not pay or cannot be afforded.
    /// </summary>
    public static IReadOnlyList<PlanStep> Plan(MatchState match, int seat)
    {
        var player = match.Players[seat];
        var empty = Plots(match, seat).Where(i => match.Installed[i] == MatchState.Nobody).ToList();
        PlanStep[] pub = [new PlanStep(GoalKind.Pub, -1, default)];
        if (empty.Count == 0) return pub;

        var objective = ChooseObjective(match, seat);
        var prices = ForecastPrices(match);
        var ledger = BuildLedger(match, seat);
        var facts = PoMuleGoapPlanner.BuildWorldFacts(
            match, seat, empty.Count, ledger.Making[(int)Good.Energy], ledger.Drawing, ledger.Making[(int)Good.Food]);
        var goapSequence = PoMuleGoapPlanner.PlanGoodSequence(match, seat, objective, facts);
        var carrying = player.HasMule && player.Outfit != MatchState.Nobody;
        var budget = player.Cash - (player.HasMule ? 0 : match.Store.MulePrice);
        var monthsLeft = PoMuleTuning.Months - match.Month + 1;

        (int Plot, Good Good, int Total) best = (-1, default, Never);
        (int Plot, Good Good, int Score) bestNext = (-1, default, 0);
        foreach (var first in empty)
        {
            for (var g = 0; g < 4; g++)
            {
                var good = (Good)g;
                if (carrying ? player.Outfit != g : PoMuleTuning.OutfitCost[g] > budget) continue;
                var score = Utility(match, seat, objective, prices, ledger, first, good);
                if (score <= Never / 2) continue;
                if (goapSequence.Count > 0 && goapSequence[0] == good) score += 35;

                // Look one M.U.L.E. further: what the next plot is worth once this one is working.
                var after = ledger.With(match.Map.Plots[first], good);
                var next = (Plot: -1, Good: Good.Food, Score: 0);
                foreach (var second in empty)
                {
                    if (second == first) continue;
                    for (var h = 0; h < 4; h++)
                    {
                        var nextGood = (Good)h;
                        var nextScore = Utility(match, seat, objective, prices, after, second, nextGood, first, good);
                        if (goapSequence.Count > 1 && goapSequence[1] == nextGood) nextScore += 25;
                        if (nextScore > next.Score) next = (second, nextGood, nextScore);
                    }
                }
                var total = score + next.Score;
                if (total > best.Total) (best, bestNext) = ((first, good, total), next);
            }
        }
        if (best.Plot < 0) return pub;

        if (!player.HasMule)
        {
            // Develop or cash out: the M.U.L.E. has to earn back its price and outfit over the
            // months left (it also counts toward Net Worth), unless the colony needs what it makes.
            var good = (int)best.Good;
            var earns = ExpectedYield(match, seat, best.Plot, best.Good) * prices[good] * monthsLeft + PoMuleTuning.MuleValue;
            var needed = (best.Good == Good.Energy && objective == Objective.SecureEnergy) || (best.Good == Good.Food && objective == Objective.SecureFood);
            if (!needed && earns < match.Store.MulePrice + PoMuleTuning.OutfitCost[good]) return pub;
        }

        var steps = new List<PlanStep>(4);
        if (!carrying) steps.Add(new PlanStep(GoalKind.Outfitter, -1, best.Good));
        steps.Add(new PlanStep(GoalKind.Install, best.Plot, best.Good));
        if (bestNext.Plot >= 0)
        {
            steps.Add(new PlanStep(GoalKind.Outfitter, -1, bestNext.Good));
            steps.Add(new PlanStep(GoalKind.Install, bestNext.Plot, bestNext.Good));
        }
        return steps;
    }

    /// <summary>What to outfit a M.U.L.E. for, given the plot it is bound for.</summary>
    public static Good ChooseOutfit(MatchState match, int seat, int plot)
    {
        var objective = ChooseObjective(match, seat);
        var prices = ForecastPrices(match);
        var ledger = BuildLedger(match, seat);
        var best = Good.Food;
        var bestScore = int.MinValue;
        for (var g = 0; g < 4; g++)
        {
            var score = Utility(match, seat, objective, prices, ledger, plot, (Good)g);
            if (score > bestScore) (best, bestScore) = ((Good)g, score);
        }
        return best;
    }

    /// <summary>Where this colonist is heading right now in the development phase.</summary>
    public static Goal NextGoal(MatchState match, int seat)
    {
        var player = match.Players[seat];
        if (!PoMuleDevelopment.CanAct(match, seat)) return new Goal(GoalKind.Idle, -1, default);

        var empty = Plots(match, seat).Where(i => match.Installed[i] == MatchState.Nobody).ToList();
        if (player.HasMule)
        {
            var step = Plan(match, seat)[0];
            return step.Kind switch
            {
                GoalKind.Outfitter => new Goal(GoalKind.Outfitter, -1, step.Good),
                GoalKind.Install => new Goal(GoalKind.Install, step.Plot, step.Good),
                _ => new Goal(GoalKind.Pub, -1, default),
            };
        }

        var timeLeft = PoMuleDevelopment.TimeLeft(match, seat);
        var working = player.Archetype != Archetype.Gambler || timeLeft > PoMuleTuning.GamblerWorksUntilTicks;
        if (working && empty.Count > 0 && match.Store.Mules > 0 && timeLeft > PoMuleTuning.LastMuleErrandTicks)
        {
            var step = Plan(match, seat)[0];
            if (step.Kind == GoalKind.Outfitter && player.Cash >= match.Store.MulePrice + PoMuleTuning.OutfitCost[(int)step.Good])
                return new Goal(GoalKind.Outfitter, -1, step.Good);
        }

        // One frightened M.U.L.E. a month is the Agitator's fun; after that it goes for a drink.
        if (player.Archetype == Archetype.Agitator && timeLeft > PoMuleTuning.AgitatorHuntsUntilTicks && match.BumpRunaways == 0)
        {
            var prey = match.Players.FirstOrDefault(p => p.Seat != seat && p.HasMule);
            return new Goal(GoalKind.Chase, prey?.Seat ?? -1, default);
        }

        if (player.Archetype == Archetype.Prospector && timeLeft > PoMuleTuning.AgitatorHuntsUntilTicks
            && !match.Has(player, Species.CrystiteWeaver))
        {
            var crater = Enumerable.Range(0, match.Assayed.Length)
                .FirstOrDefault(i => !match.Assayed[i] && match.Map.Plots[i].Terrain == Terrain.Crater, -1);
            if (crater >= 0)
                return player.HoldsAssay ? new Goal(GoalKind.Survey, crater, default) : new Goal(GoalKind.Assay, -1, default);
        }

        return new Goal(GoalKind.Pub, -1, default);
    }

    // ── Market prediction ──

    /// <summary>
    /// Next month's Store price for a good and whether the colony is heading for a shortage,
    /// from what is in stock, what the M.U.L.E.s will make and eat, and the Store's own pricing
    /// rule. Price is a smoothed blend of the coming close and the one after it (trend / 3).
    /// </summary>
    public static Forecast ForecastFor(MatchState match, Good good)
    {
        var g = (int)good;
        var price = match.Store.Price[g];
        switch (good)
        {
            case Good.Food or Good.Energy:
                var supply = match.Store.Stock[g] + match.Players.Sum(p => p.Goods[g]);
                var made = 0;
                var burning = 0;
                for (var i = 0; i < match.Installed.Length; i++)
                {
                    if (match.Installed[i] == MatchState.Nobody || match.Owner[i] == MatchState.Nobody) continue;
                    if (match.Installed[i] == g) made += PoMuleProduction.BaseYield(match.Map.Plots[i], good);
                    if (match.Installed[i] != (sbyte)Good.Energy) burning++;
                }
                var seats = match.Players.Length;
                var needNow = good == Good.Food ? seats * PoMuleTuning.FoodNeed(match.Month + 1) : burning;
                var needNext = good == Good.Food ? seats * PoMuleTuning.FoodNeed(match.Month + 2) : burning;
                var eaten = good == Good.Food ? seats * PoMuleTuning.FoodNeed(match.Month + 1) : burning;
                var supplyNext = Math.Max(0, supply + made - eaten);
                var p0 = PoMuleMarket.NextPrice(good, price, supply, needNow);
                var p1 = PoMuleMarket.NextPrice(good, p0, supplyNext, needNext);
                return new Forecast(p0 + (p1 - p0) / 3, supply < needNow || supplyNext < needNext);
            case Good.Smithore:
                // Ore sold today becomes M.U.L.E.s at month end, and plentiful M.U.L.E.s cheapen ore.
                var smithore = PoMuleMarket.SmithorePrice(match.Store.Mules + match.Store.Stock[g] / PoMuleTuning.SmithorePerMule);
                return new Forecast(smithore, smithore * 100 > price * 108);
            default:
                // The Federation draws Crystite's price at random: the middle of the range is the best guess.
                return new Forecast((PoMuleTuning.PriceMin[g] + PoMuleTuning.PriceMax[g]) / 2, false);
        }
    }

    private static bool ExpectedShort(MatchState match, Good good) => ForecastFor(match, good).Scarce;

    /// <summary>
    /// Extra Food or Energy a trader will not sell when the colony is forecast to run short:
    /// bigger early on, and capped small because spare Food halves and spare Energy loses a
    /// quarter every month it sits in the warehouse.
    /// </summary>
    private static int ShortageReserve(MatchState match, Good good, Forecast forecast) =>
        !forecast.Scarce || good is not (Good.Food or Good.Energy) ? 0
        : Math.Min(good == Good.Food ? 3 : 2, match.Month <= 6 ? 3 : 2);


    /// <summary>Which way this colonist walks on the trading floor this tick: +1 up, -1 down, 0 stay.</summary>
    public static int MarketInput(MatchState match, int seat)
    {
        var role = match.LaneRole[seat];
        if (role == 0 || match.MarketGood == MatchState.Nobody) return 0;
        var good = (Good)match.MarketGood;
        var player = match.Players[seat];
        var (floor, ceiling) = (PoMuleMarket.Floor(match, good), PoMuleMarket.Ceiling(match, good));
        var surplus = PoMuleMarket.Surplus(match, seat, good);
        var here = match.LanePrice[seat];

        if (role == PoMuleMarket.Buyer)
        {
            if (surplus >= 0) return -1;
            // Short: it has to buy, but not at any price while the clock allows. With the price
            // forecast to fall it waits at a fair bid (a third up the axis, where sellers ask);
            // otherwise, or at last call, it walks up to whatever it takes.
            var falling = match.Store.Price[(int)good] * 100 > ForecastFor(match, good).Price * 108;
            var patient = falling && match.ClockTicks >= PoMuleTuning.MarketLastCallTicks;
            var limit = Math.Min(player.Cash, patient ? floor + (ceiling - floor) / 3 : ceiling);
            return Math.Sign(limit - here);
        }

        var essential = good is Good.Food or Good.Energy;
        var forecast = ForecastFor(match, good);
        // Keep a little Food and Energy back: next month brings a bad harvest or a new M.U.L.E.
        // When the colony is forecast to run short, keep more back and do not sell it dry.
        var reserve = essential ? PoMuleTuning.AiReserve[(int)good] + ShortageReserve(match, good, forecast) : 0;
        if (surplus <= reserve) return 1;
        var price = match.Store.Price[(int)good];
        // Spare Food and Energy rot, so with the bell about to ring everyone but the
        // Hoarder takes the Store's price rather than carry it home.
        if (essential && player.Archetype != Archetype.Hoarder && match.ClockTicks < PoMuleTuning.MarketLastCallTicks)
            return Math.Sign(floor - here);
        // Today's price is well above next month's forecast: sell the surplus now. Well below
        // it: hold the surplus at the top of the lane until the price catches up.
        if (price * 100 > forecast.Price * 112) return Math.Sign(floor - here);
        if (price * 100 < forecast.Price * 88) return Math.Sign(ceiling - here);
        var target = (player.Archetype, essential) switch
        {
            // Sits on Food and Energy until the price is close to its record high.
            (Archetype.Hoarder, true) => price * 100 >= PoMuleTuning.PriceMax[(int)good] * 80 ? (floor + ceiling) / 2 : ceiling,
            (Archetype.Farmer, true) => floor + (ceiling - floor) / 5,
            // Holds ore for a spike, then dumps it on the Store.
            (Archetype.Speculator, false) => price * 10 >= PoMuleTuning.StoreStartPrice[(int)good] * 13 ? floor : ceiling,
            // Other colonists ask a third above the Store's price for essentials; ore has no
            // buyer but the Store, so it goes to the floor.
            (_, true) => floor + (ceiling - floor) / 3,
            _ => floor,
        };
        return Math.Sign(target - here);
    }

    /// <summary>The most this colonist will pay for the plot on the block: a share of its cash, more for land it likes.</summary>
    public static int AuctionLimit(MatchState match, int seat)
    {
        var player = match.Players[seat];
        var percent = player.Archetype switch
        {
            Archetype.Speculator => 42,
            Archetype.Gambler => 38,
            Archetype.Agitator => 20,
            _ => 30,
        };
        // Terrain appeal runs 20–100: land this personality lives on is worth up to a fifth more.
        var appeal = match.AuctionPlot < 0 ? 20 : Appeal(player.Archetype, match.Map.Plots[match.AuctionPlot].Terrain);
        return player.Cash * percent / 100 * (100 + appeal / 5) / 100;
    }

    /// <summary>
    /// Percent chance per tick that this colonist takes its next step up the land-auction
    /// floor: brisk with plenty of room under its limit, hesitant close to it, so the bidders
    /// string out instead of climbing in a row.
    /// </summary>
    public static int AuctionEagerness(MatchState match, int seat)
    {
        var limit = AuctionLimit(match, seat);
        var span = Math.Max(1, limit - PoMuleLand.AuctionFloor);
        return Math.Clamp(10 + 30 * (limit - match.LanePrice[seat]) / span, 10, 40);
    }

    /// <summary>Which way this colonist walks on the land-auction floor: +1 to raise its bid, 0 to stand.</summary>
    public static int AuctionInput(MatchState match, int seat)
    {
        if (match.AuctionPlot < 0 || match.HighBidder == seat) return 0;
        return match.LanePrice[seat] + PoMuleTuning.AuctionStep <= AuctionLimit(match, seat) ? 1 : 0;
    }
}
