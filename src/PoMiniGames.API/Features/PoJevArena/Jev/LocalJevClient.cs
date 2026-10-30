using PoMiniGames.Shared.Games.PoJevArena;

namespace PoMiniGames.Features.PoJevArena.Jev;

/// <summary>
/// The free default brain. Plain tactics rules read the same validated numbers Jev would and
/// answer the same three questions with the same option ids, so the engine, the Black Box and the
/// debrief work unchanged. Deterministic, no I/O, no allowance:
/// <list type="bullet">
/// <item>Focus follows the creature's target bias, but a nearly dead enemy close by is finished
/// first (focus fire), a badly hurt ally pulls healers and guardians, and a unit being hit up
/// close does not cross the arena for its favourite target.</item>
/// <item>Panic follows the creature's panic threshold (HP, odds, allies), softened for
/// berserkers and anchors.</item>
/// <item>Action: heal a hurt ally, survive at low HP (shell, dash, cover, regroup, retreat),
/// react to incoming fire, use ranged abilities in range, otherwise charge.</item>
/// </list>
/// </summary>
public sealed class LocalJevClient : IJevClient
{
    private const double Chosen = 0.7;

    private const string Nearest = "nearest_threat";
    private const string Weakest = "weakest_target";
    private const string Strongest = "strongest_threat";
    private const string Ranged = "ranged_threat";
    private const string Protect = "protect_ally";

    private const string Melee = "melee_charge";
    private const string Peel = "peel_to_ally";
    private const string FallBack = "fall_back";
    private const string Cover = "take_cover";
    private const string Kite = "kite_and_shoot";
    private const string Boulder = "lob_boulder";
    private const string Mend = "mend_ally";
    private const string Brace = "shield_brace";
    private const string Shell = "shell_up";
    private const string Dash = "dodge_dash";

    /// <summary>Matches the engine's PANIC_THRESHOLD: above it the unit breaks and flees.</summary>
    private const double PanicBreak = 0.7;

    public bool IsConfigured => true;

    public Task<JevOutcome> EvaluateAsync(JevPrompt prompt, string sessionId, string user, CancellationToken ct = default) =>
        Task.FromResult(Decide(prompt));

    /// <summary>Answers from <see cref="JevPrompt.Facts"/>; a prompt without them is reported as malformed.</summary>
    internal static JevOutcome Decide(JevPrompt prompt)
    {
        if (prompt.Facts is not { } facts
            || !prompt.Questions.TryGetValue(JevPromptBuilder.ActionKey, out var actionQuestion)
            || actionQuestion.Criteria.Count == 0)
        {
            return JevOutcome.Fail("malformed");
        }

        var read = new Read(facts);
        string? focus = null;
        Dictionary<string, double>? focusProbabilities = null;
        if (prompt.Questions.TryGetValue(JevPromptBuilder.FocusKey, out var focusQuestion) && focusQuestion.Criteria.Count > 0)
        {
            focus = PickFocus(read, focusQuestion.Criteria);
            focusProbabilities = Spread(focus, focusQuestion.Criteria.Keys);
        }

        var panic = Panic(read);
        var target = focus is null ? read.Candidate(Nearest) : read.Candidate(focus);
        var action = PickAction(read, target, panic, actionQuestion.Criteria);

        var answers = new JevAnswers(
            action, Chosen, Spread(action, actionQuestion.Criteria.Keys),
            focus, focus is null ? 0 : Chosen, focusProbabilities, panic);
        return new JevOutcome(true, null, answers, LatencyMs: 0);
    }

    private static string PickFocus(Read read, IReadOnlyDictionary<string, string> offered)
    {
        bool Has(string f) => offered.ContainsKey(f);

        // Focus fire: a nearly dead enemy within reach beats any personality.
        if (Has(Weakest) && read.Candidate(Weakest) is { } weak && weak.Candidate.HpPercent <= 30 && weak.Candidate.DistanceM <= 6)
        {
            return Weakest;
        }

        // A badly hurt ally pulls healers and guardians.
        var guardian = read.Has(Mend) || read.Subject.TargetBias == "protect_allies" || read.Subject.Temperament == "loyal_guardian";
        if (Has(Protect) && guardian && read.Candidate(Protect) is { Candidate.HpPercent: < 50 })
        {
            return Protect;
        }

        var preferred = read.Subject.TargetBias switch
        {
            "hunt_weakest" => Weakest,
            "challenge_strongest" => Strongest,
            "focus_ranged" => Ranged,
            "protect_allies" when read.Candidate(Protect) is { Candidate.HpPercent: < 80 } => Protect,
            _ => Nearest,
        };

        // Someone is already hitting us up close: deal with them before crossing the arena.
        if (preferred != Nearest && Has(Nearest) && read.State.UnderFire
            && read.Candidate(Nearest) is { } near && near.Candidate.DistanceM < 2
            && (read.Candidate(preferred)?.Candidate.DistanceM ?? 0) > near.Candidate.DistanceM + 6)
        {
            return Nearest;
        }

        if (Has(preferred)) return preferred;
        return Has(Nearest) ? Nearest : offered.Keys.First();
    }

    private static double Panic(Read read)
    {
        var hp = read.HpFraction;
        var (allies, enemies) = (read.AlliesAlive, read.EnemiesAlive);
        var p = read.Subject.PanicThreshold switch
        {
            "fights_to_death" => 0.02,
            "panics_under_25_hp" => hp < 0.25 ? 0.85 : hp < 0.35 ? 0.4 : 0.05,
            "panics_under_50_hp" => hp < 0.5 ? 0.8 : hp < 0.6 ? 0.4 : 0.05,
            "flees_if_outnumbered" => enemies >= allies + 3 ? 0.8 : enemies > allies ? 0.35 : 0.05,
            "flees_when_alone" => read.State.AlliesNear == 0 ? (read.State.UnderFire ? 0.8 : 0.3) : 0.05,
            "breaks_when_allies_fall" => allies <= 3 ? 0.8 : allies <= 5 ? 0.4 : 0.05,
            _ => 0.1,
        };
        p *= read.Subject.Temperament switch
        {
            "reckless_berserker" => 0.5,
            "disciplined_anchor" => 0.75,
            _ => 1,
        };
        return Math.Round(p, 2);
    }

    private static string PickAction(Read read, JevCandidateFact? target, double panic, IReadOnlyDictionary<string, string> offered)
    {
        bool Can(string o) => offered.ContainsKey(o);
        bool Ready(string o) => Can(o) && read.Ready(o);

        var state = read.State;
        var hp = read.HpFraction;
        var dist = target?.Candidate.DistanceM ?? double.MaxValue;
        var coverNear = state.CoverDistanceM is >= 0 and <= 5;
        var hasAllies = read.AlliesAlive > 1;

        if (panic > PanicBreak)
        {
            if (Can(Cover) && coverNear) return Cover;
            return Can(Peel) && hasAllies ? Peel : FallBack;
        }

        // Healers heal first.
        if (Ready(Mend) && read.Candidate(Protect) is { Candidate.HpPercent: < 70 }) return Mend;

        // Low HP: survive, unless a berserker or the target is weaker still and nobody is hitting us.
        var targetWeaker = target is not null && target.Candidate.HpPercent < hp * 100;
        if (hp < 0.3 && read.Subject.Temperament != "reckless_berserker" && (state.UnderFire || !targetWeaker))
        {
            if (state.UnderFire && Ready(Shell)) return Shell;
            if (state.UnderFire && Ready(Dash)) return Dash;
            if (Can(Cover) && coverNear) return Cover;
            if (Can(Peel) && hasAllies && state.AlliesNear == 0) return Peel;
            return FallBack;
        }

        // Reactions to incoming fire.
        if (state.UnderFire)
        {
            if (Ready(Shell) && hp < 0.6) return Shell;
            if (Ready(Dash) && dist < 2.5 && hp < 0.7) return Dash;
            if (Can(Brace) && dist < 2 && (read.Subject.Temperament == "disciplined_anchor" || hp < 0.5)) return Brace;
        }

        // Ranged tools inside their range.
        if (Ready(Boulder) && dist is >= 1.5 and <= 7) return Boulder;
        if (Can(Kite) && dist <= 11 && (Ready(Kite) || dist < 4)) return Kite;

        // Snipers without a gun still keep their distance when hurt.
        if (read.Subject.Temperament == "cautious_sniper" && dist < 3 && hp < 0.5) return FallBack;

        return Can(Melee) ? Melee : offered.Keys.First();
    }

    /// <summary>The chosen option at <see cref="Chosen"/>, the rest sharing what is left.</summary>
    private static Dictionary<string, double> Spread(string chosen, IEnumerable<string> options)
    {
        var all = options.ToList();
        if (all.Count == 1) return new Dictionary<string, double>(StringComparer.Ordinal) { [chosen] = 1.0 };
        var rest = Math.Round((1 - Chosen) / (all.Count - 1), 4);
        return all.ToDictionary(o => o, o => o == chosen ? Chosen : rest, StringComparer.Ordinal);
    }

    /// <summary>The facts, pre-chewed.</summary>
    private sealed class Read(JevPromptFacts facts)
    {
        public ArenaCreature Subject => facts.Subject;
        public ArenaUnitState State => facts.State;
        public double HpFraction { get; } = facts.State.Hp / (double)PoJevArenaRules.BattleHp(facts.Subject.MaxHp);
        public int AlliesAlive => facts.Blue ? facts.State.BlueAlive : facts.State.RedAlive;
        public int EnemiesAlive => facts.Blue ? facts.State.RedAlive : facts.State.BlueAlive;

        public JevCandidateFact? Candidate(string focus)
        {
            foreach (var c in facts.Candidates)
            {
                if (c.Candidate.Focus == focus) return c;
            }
            return null;
        }

        /// <summary>The creature carries the ability behind this option.</summary>
        public bool Has(string option) => IndexOf(option) >= 0;

        /// <summary>The creature carries the ability behind this option and it is off cooldown.</summary>
        public bool Ready(string option)
        {
            var i = IndexOf(option);
            if (i < 0) return option is Melee or Peel or FallBack or Cover;
            var cooldowns = facts.State.AbilityCooldowns;
            return i < cooldowns.Length && cooldowns[i] <= 0;
        }

        private int IndexOf(string option)
        {
            var abilities = facts.Subject.Abilities;
            for (var i = 0; i < abilities.Length; i++)
            {
                if (PoJevArenaCatalog.FindAbility(abilities[i])?.JevOption == option) return i;
            }
            return -1;
        }
    }
}
