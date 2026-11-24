namespace PoMiniGames.Shared.Games.PoMule;

/// <summary>
/// Deterministic A* Goal-Oriented Action Planning (GOAP) planner for PoMule colonists (#3).
/// Chains up to 3 development steps over a compact bitmask world state (<= 48 expanded nodes,
/// &lt;0.6 ms in Blazor WASM) so AI colonists sequence Energy -> Food -> High-margin Ore/Crystite
/// or scarce-market cornering instead of greedy single-step picks.
/// </summary>
public static class PoMuleGoapPlanner
{
    [Flags]
    public enum WorldFacts : uint
    {
        None = 0,
        HasEmptyPlot = 1 << 0,
        EnergyCovered = 1 << 1,
        FoodCovered = 1 << 2,
        HasCashForMule = 1 << 3,
        StoreFoodScarce = 1 << 4,
        StoreEnergyScarce = 1 << 5,
        StoreSmithoreScarce = 1 << 6,
        StoreCrystiteScarce = 1 << 7,
        Endgame = 1 << 8,
    }

    public readonly record struct GoapAction(
        string Name,
        GoalKind Kind,
        Good Good,
        WorldFacts Preconditions,
        WorldFacts Effects,
        int BaseCost);

    private readonly record struct SearchNode(
        WorldFacts State,
        int GCost,
        int FCost,
        int Depth,
        int ParentIndex,
        int ActionIndex);

    private const int MaxExpansions = 48;
    private const int MaxDepth = 3;

    private static readonly GoapAction[] Actions =
    [
        new("InstallEnergy", GoalKind.Install, Good.Energy,
            WorldFacts.HasEmptyPlot | WorldFacts.HasCashForMule,
            WorldFacts.EnergyCovered, 10),
        new("InstallFood", GoalKind.Install, Good.Food,
            WorldFacts.HasEmptyPlot | WorldFacts.HasCashForMule | WorldFacts.EnergyCovered,
            WorldFacts.FoodCovered, 12),
        new("InstallSmithore", GoalKind.Install, Good.Smithore,
            WorldFacts.HasEmptyPlot | WorldFacts.HasCashForMule | WorldFacts.EnergyCovered | WorldFacts.FoodCovered,
            WorldFacts.StoreSmithoreScarce, 14),
        new("InstallCrystite", GoalKind.Install, Good.Crystite,
            WorldFacts.HasEmptyPlot | WorldFacts.HasCashForMule | WorldFacts.EnergyCovered | WorldFacts.FoodCovered,
            WorldFacts.StoreCrystiteScarce, 15),
        new("CashOutPub", GoalKind.Pub, Good.Food,
            WorldFacts.None,
            WorldFacts.Endgame, 25),
    ];

    /// <summary>
    /// Computes the current bitmask world state for <paramref name="seat"/>.
    /// </summary>
    public static WorldFacts BuildWorldFacts(MatchState match, int seat, int emptyPlotCount, int energyMaking, int energyDrawing, int foodMaking)
    {
        var player = match.Players[seat];
        var facts = WorldFacts.None;
        if (emptyPlotCount > 0) facts |= WorldFacts.HasEmptyPlot;
        if (energyMaking >= energyDrawing + 1 || player.Goods[(int)Good.Energy] >= (energyDrawing + 1) * 2)
            facts |= WorldFacts.EnergyCovered;
        if (foodMaking >= PoMuleTuning.FoodNeed(match.Month + 1) || player.Goods[(int)Good.Food] + foodMaking >= PoMuleTuning.FoodNeed(match.Month + 1))
            facts |= WorldFacts.FoodCovered;
        if (player.HasMule || player.Cash >= match.Store.MulePrice + PoMuleTuning.OutfitCost[(int)Good.Food])
            facts |= WorldFacts.HasCashForMule;
        if (PoMuleAi.ForecastFor(match, Good.Food).Scarce) facts |= WorldFacts.StoreFoodScarce;
        if (PoMuleAi.ForecastFor(match, Good.Energy).Scarce) facts |= WorldFacts.StoreEnergyScarce;
        if (PoMuleAi.ForecastFor(match, Good.Smithore).Scarce) facts |= WorldFacts.StoreSmithoreScarce;
        if (PoMuleAi.ForecastFor(match, Good.Crystite).Scarce) facts |= WorldFacts.StoreCrystiteScarce;
        if (match.Month >= PoMuleTuning.Months - 1) facts |= WorldFacts.Endgame;
        return facts;
    }

    /// <summary>
    /// Runs bounded A* over <see cref="Actions"/> to return an ordered good-priority sequence
    /// (up to 3 steps) satisfying the colonist's <paramref name="objective"/>.
    /// </summary>
    public static IReadOnlyList<Good> PlanGoodSequence(MatchState match, int seat, Objective objective, WorldFacts startFacts)
    {
        var goal = objective switch
        {
            Objective.SecureEnergy => WorldFacts.EnergyCovered,
            Objective.SecureFood => WorldFacts.EnergyCovered | WorldFacts.FoodCovered,
            Objective.MineSmithore => WorldFacts.EnergyCovered | WorldFacts.FoodCovered | WorldFacts.StoreSmithoreScarce,
            Objective.MineCrystite => WorldFacts.EnergyCovered | WorldFacts.FoodCovered | WorldFacts.StoreCrystiteScarce,
            Objective.CornerScarce => WorldFacts.EnergyCovered | WorldFacts.FoodCovered |
                ((startFacts & WorldFacts.StoreCrystiteScarce) != 0 ? WorldFacts.StoreCrystiteScarce : WorldFacts.StoreSmithoreScarce),
            _ => WorldFacts.Endgame,
        };

        var nodes = new List<SearchNode>(MaxExpansions)
        {
            new(startFacts, 0, Heuristic(startFacts, goal), 0, -1, -1),
        };
        var open = new PriorityQueue<int, int>();
        open.Enqueue(0, nodes[0].FCost);

        int bestGoalIdx = -1;
        int bestPartialIdx = 0;
        int bestPartialH = Heuristic(startFacts, goal);
        int expansions = 0;

        while (open.Count > 0 && expansions < MaxExpansions)
        {
            int curIdx = open.Dequeue();
            var cur = nodes[curIdx];
            expansions++;

            int h = Heuristic(cur.State, goal);
            if (h == 0 && cur.Depth > 0)
            {
                bestGoalIdx = curIdx;
                break;
            }
            if (h < bestPartialH && cur.Depth > 0)
            {
                bestPartialH = h;
                bestPartialIdx = curIdx;
            }
            if (cur.Depth >= MaxDepth) continue;

            for (int a = 0; a < Actions.Length; a++)
            {
                var act = Actions[a];
                if ((cur.State & act.Preconditions) != act.Preconditions) continue;
                var nextState = cur.State | act.Effects;
                if (nextState == cur.State) continue;

                int stepCost = ActionCost(match, seat, act);
                int g = cur.GCost + stepCost;
                int nh = Heuristic(nextState, goal);
                int nextIdx = nodes.Count;
                nodes.Add(new SearchNode(nextState, g, g + nh, cur.Depth + 1, curIdx, a));
                open.Enqueue(nextIdx, g + nh);
            }
        }

        int trace = bestGoalIdx >= 0 ? bestGoalIdx : bestPartialIdx;
        var goods = new List<Good>(MaxDepth);
        while (trace > 0)
        {
            var n = nodes[trace];
            if (n.ActionIndex >= 0 && Actions[n.ActionIndex].Kind == GoalKind.Install)
            {
                goods.Add(Actions[n.ActionIndex].Good);
            }
            trace = n.ParentIndex;
        }
        goods.Reverse();
        return goods;
    }

    private static int Heuristic(WorldFacts state, WorldFacts goal)
    {
        uint missing = (uint)(goal & ~state);
        return System.Numerics.BitOperations.PopCount(missing) * 10;
    }

    private static int ActionCost(MatchState match, int seat, GoapAction action)
    {
        if (action.Kind != GoalKind.Install) return action.BaseCost;
        var forecast = PoMuleAi.ForecastFor(match, action.Good);
        int scarcityBonus = forecast.Scarce ? -3 : 0;
        int priceBonus = Math.Min(5, forecast.Price / 30);
        int outfitPenalty = PoMuleTuning.OutfitCost[(int)action.Good] / 40;
        int speciesBonus = (match.Players[seat].Species, action.Good) switch
        {
            (Species.Gollumoid, Good.Food) => -3,
            (Species.OreGorger, Good.Smithore) => -3,
            (Species.CrystiteWeaver, Good.Crystite) => -3,
            (Species.Voltronix, Good.Energy) => -3,
            _ => 0,
        };
        return Math.Max(1, action.BaseCost + outfitPenalty + scarcityBonus + speciesBonus - priceBonus);
    }
}
