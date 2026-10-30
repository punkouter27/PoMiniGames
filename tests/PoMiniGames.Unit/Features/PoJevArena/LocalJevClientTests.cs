using FluentAssertions;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Features.PoJevArena.Jev;
using PoMiniGames.Shared.Games.PoJevArena;
using Xunit;

namespace PoMiniGames.Unit.Features.PoJevArena;

/// <summary>
/// The free default brain answers Jev's three questions from the same validated numbers, only
/// with options the unit was offered, and with tactics a player would recognise.
/// </summary>
public sealed class LocalJevClientTests
{
    private static readonly ArenaCreature PlainClaw = new(
        "lib-plain01", "Plain Claw", 220, 4.5, 3.0, [], "opportunist", "engage_closest",
        "flees_if_outnumbered", PoJevArenaRules.BuildCost(220, 4.5, 3.0, []), OwnerName: "Tester");

    // Blue-01..05 are the presets in catalog order (tank, berserker, spitter, brute, medic), Blue-06 Plain Claw.
    private static readonly ArenaRoster Roster = new(
        Blue: [.. PoJevArenaCatalog.Presets, PlainClaw, .. PoJevArenaCatalog.Presets[..4]],
        Red: [.. PoJevArenaCatalog.Presets, .. PoJevArenaCatalog.Presets]);

    [Theory]
    [InlineData("tank-charges-nearest", "melee_charge", "nearest_threat", false)]
    [InlineData("focus-fire-finishes-the-weak", "melee_charge", "weakest_target", false)]
    [InlineData("medic-heals-hurt-ally", "mend_ally", "protect_ally", false)]
    [InlineData("spitter-kites-in-range", "kite_and_shoot", "weakest_target", false)]
    [InlineData("low-hp-falls-back", "fall_back", "nearest_threat", false)]
    [InlineData("outnumbered-breaks", "peel_to_ally", "nearest_threat", true)]
    [InlineData("berserker-never-breaks", "melee_charge", "weakest_target", false)]
    [InlineData("no-facts", null, null, false)]
    public async Task LocalBrain_PicksSensibleOfferedOptions(string scenario, string? action, string? focus, bool panics)
    {
        var prompt = scenario == "no-facts"
            ? new JevPrompt("Subject: Blue-01", new Dictionary<string, JevQuestion>())
            : JevPromptBuilder.Build(Roster, State(scenario)).Prompt!;

        var outcome = await new LocalJevClient().EvaluateAsync(prompt, "match-1", "user");

        if (action is null)
        {
            outcome.Ok.Should().BeFalse();
            outcome.Failure.Should().Be("malformed");
            return;
        }

        outcome.Ok.Should().BeTrue(outcome.Failure);
        outcome.Answers!.Action.Should().Be(action);
        outcome.Answers.Focus.Should().Be(focus);
        (outcome.Answers.Panic > 0.7).Should().Be(panics);
        prompt.Questions[JevPromptBuilder.ActionKey].Criteria.Should().ContainKey(outcome.Answers.Action, "only offered options");
        outcome.Answers.ActionProbabilities.Values.Sum().Should().BeApproximately(1, 0.01);
    }

    private static ArenaUnitState State(string scenario)
    {
        ArenaCandidate[] calm =
        [
            new("nearest_threat", "Red-01", 2.3, 85),
            new("weakest_target", "Red-03", 6.8, 40),
            new("strongest_threat", "Red-04", 9.4, 100),
            new("protect_ally", "Blue-02", 3.1, 90),
        ];
        var battleHp = (int slot) => PoJevArenaRules.BattleHp(Roster.Blue[slot].MaxHp);

        return scenario switch
        {
            "tank-charges-nearest" => Unit("Blue-01", battleHp(0), [0], calm),
            "focus-fire-finishes-the-weak" => Unit("Blue-01", battleHp(0), [0],
                [.. calm.Where(c => c.Focus != "weakest_target"), new("weakest_target", "Red-03", 4.0, 20)]),
            "medic-heals-hurt-ally" => Unit("Blue-05", battleHp(4), [0, 0],
                [.. calm.Where(c => c.Focus != "protect_ally"), new("protect_ally", "Blue-02", 3.1, 40)]),
            "spitter-kites-in-range" => Unit("Blue-03", battleHp(2), [0, 4], calm),
            "low-hp-falls-back" => Unit("Blue-06", battleHp(5) / 10, [], calm) with { UnderFire = true },
            "outnumbered-breaks" => Unit("Blue-06", battleHp(5), [], calm) with { BlueAlive = 2, RedAlive = 9 },
            "berserker-never-breaks" => Unit("Blue-02", battleHp(1) / 10, [4], calm) with { UnderFire = true },
            _ => throw new ArgumentOutOfRangeException(nameof(scenario), scenario, null),
        };
    }

    private static ArenaUnitState Unit(string unit, int hp, double[] cooldowns, ArenaCandidate[] candidates) => new(
        Unit: unit,
        Hp: Math.Max(1, hp),
        AbilityCooldowns: cooldowns,
        Poisoned: false,
        UnderFire: false,
        AlliesNear: 1,
        Candidates: [.. candidates.Where(c => c.Unit != unit)],
        BlueAlive: 8,
        RedAlive: 8);
}
