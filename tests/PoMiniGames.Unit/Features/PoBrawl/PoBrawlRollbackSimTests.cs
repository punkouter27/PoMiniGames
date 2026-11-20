using FluentAssertions;
using PoMiniGames.Shared.Games;
using Sim = PoMiniGames.Shared.Games.PoBrawlRollbackSim;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// The online fight's rules, on the server's copy. The same rules are written a second time in
/// <c>wwwroot/js/pobrawl/rollbackSim.js</c> and the two must agree bit for bit:
/// <c>scripts/dev/brawl-rollback-golden.mjs</c> asserts these same cases on the JavaScript copy and
/// prints the checksums <see cref="Golden"/> expects of this one.
/// </summary>
public sealed class PoBrawlRollbackSimTests
{
    private const int FightStart = 5;

    /// <summary>A fight past its pre-roll, the corners <paramref name="gap"/> mm apart around the centre.</summary>
    private static PoBrawlSimState FightAt(int gap)
    {
        var s = Sim.Create(12345, FightStart);
        for (var i = 0; i < FightStart; i++) Sim.Step(ref s, 0, 0);
        s.P1.X = -(gap >> 1);
        s.P2.X = gap - (gap >> 1);
        return s;
    }

    private static void Idle(ref PoBrawlSimState s, int frames)
    {
        for (var i = 0; i < frames; i++) Sim.Step(ref s, 0, 0);
    }

    private static int Press(int press) => Sim.EncodeInput(-1, press);

    private static int Hold(int held) => Sim.EncodeInput(held, Sim.PressNone);

    [Fact]
    public void Grab_GoesThroughAHeldGuard_Throws_AndRollsNoDice()
    {
        var s = FightAt(1200);
        Sim.Step(ref s, 0, Hold(Sim.HeldBlock));
        var rng = s.Rng;
        var x2 = s.P2.X;

        Sim.Step(ref s, Press(Sim.PressGrab), 0);

        s.P1.Outcome.Should().Be(Sim.OutcomeHit);
        s.P1.Swing.Should().Be(Sim.PressGrab);
        s.P2.Hp.Should().Be(100 - Sim.GrabDamage);
        s.P2.X.Should().Be(x2 + Sim.GrabThrowMm);
        s.Rng.Should().Be(rng, "a grab does not move the RNG");
        s.P1.Cooldown.Should().Be(Sim.GrabHitCooldown - 1);
    }

    [Fact]
    public void Grab_LosesToAnyStrike()
    {
        // The corner that swings on the same frame cannot be grabbed...
        var s = FightAt(1200);
        Sim.Step(ref s, Press(Sim.PressGrab), Press(Sim.PressPunch));
        s.P1.Outcome.Should().Be(Sim.OutcomeWhiff);
        s.P2.Outcome.Should().Be(Sim.OutcomeHit);
        s.P1.Hp.Should().BeLessThan(100);
        s.P2.Hp.Should().Be(100);
        s.P1.Cooldown.Should().Be(Sim.GrabCooldown - 1, "grabbing air costs the long cooldown");

        // ...and neither can one still recovering from a swing.
        var r = FightAt(1200);
        Sim.Step(ref r, 0, Press(Sim.PressKick));
        Sim.Step(ref r, Press(Sim.PressGrab), 0);
        r.P1.Outcome.Should().Be(Sim.OutcomeWhiff);
    }

    [Fact]
    public void Grab_WhiffsOutOfReach_AndTwoAtOnceBreak()
    {
        var far = FightAt(Sim.GrabReachMm + 1);
        Sim.Step(ref far, Press(Sim.PressGrab), 0);
        far.P1.Outcome.Should().Be(Sim.OutcomeWhiff);

        var both = FightAt(1200);
        Sim.Step(ref both, Press(Sim.PressGrab), Press(Sim.PressGrab));
        both.P1.Outcome.Should().Be(Sim.OutcomeBreak);
        both.P2.Outcome.Should().Be(Sim.OutcomeBreak);
        (both.P1.Hp + both.P2.Hp).Should().Be(200);
        (both.P2.X - both.P1.X).Should().Be(1200 + (2 * Sim.GrabBreakMm));
    }

    [Fact]
    public void Grab_IsNeverTheKnockout()
    {
        var s = FightAt(1200);
        s.P2.Hp = 3;

        Sim.Step(ref s, Press(Sim.PressGrab), 0);

        s.P2.Hp.Should().Be(1);
        s.Over.Should().Be(0);
    }

    [Fact]
    public void Taunt_IsRefusedInRange_TakenOutOfRange_AndPaysOnItsLastFrame()
    {
        var near = FightAt(Sim.KickReachMm + Sim.TauntClearMm);
        Sim.Step(ref near, Press(Sim.PressTaunt), 0);
        near.P1.Taunt.Should().Be(0, "in range the press is spent");
        near.P1.Pending.Should().Be(Sim.PressNone);

        var s = FightAt(4000);
        s.P1.Energy = 0;
        Sim.Step(ref s, Press(Sim.PressTaunt), 0);
        s.P1.Taunt.Should().Be(Sim.TauntFrames - 1);
        s.P1.Swing.Should().Be(Sim.PressTaunt);

        var x1 = s.P1.X;
        Sim.Step(ref s, Hold(Sim.HeldForward), 0);
        s.P1.X.Should().Be(x1, "a taunting corner does not walk");

        var before = s.P1.Energy;
        Idle(ref s, Sim.TauntFrames - 3);
        s.P1.Taunt.Should().Be(1);
        Sim.Step(ref s, 0, 0);
        s.P1.Taunt.Should().Be(0);
        s.P1.Energy.Should().BeGreaterThanOrEqualTo(before + Sim.TauntEnergy, "the bar jumps as it ends");

        Sim.Step(ref s, Press(Sim.PressTaunt), 0);
        s.P1.Taunt.Should().Be(0, "on cooldown the press is spent");
    }

    [Fact]
    public void Taunt_CaughtByABlowOrAGrab_TakesMoreAndEnds()
    {
        var s = FightAt(4000);
        Sim.Step(ref s, Press(Sim.PressTaunt), 0);
        s.P2.X = s.P1.X + 1400;              // the other corner is suddenly in kick range
        var twin = s;                        // a struct: this is a copy
        twin.P1.Taunt = 0;                   // the same kick on a corner that is not taunting

        Sim.Step(ref s, 0, Press(Sim.PressKick));
        Sim.Step(ref twin, 0, Press(Sim.PressKick));

        s.P1.Taunt.Should().Be(0);
        s.P2.Damage.Should().Be(((twin.P2.Damage * Sim.TauntPunishPct) + 50) / 100);
        s.P2.Damage.Should().BeGreaterThan(twin.P2.Damage);

        // A taunting corner can be grabbed even though it is not "recovering".
        var g = FightAt(4000);
        Sim.Step(ref g, Press(Sim.PressTaunt), 0);
        g.P2.X = g.P1.X + 1200;
        Sim.Step(ref g, 0, Press(Sim.PressGrab));
        g.P2.Outcome.Should().Be(Sim.OutcomeHit);
        g.P1.Hp.Should().Be(100 - (((Sim.GrabDamage * Sim.TauntPunishPct) + 50) / 100));
    }

    [Fact]
    public void Pack_RoundTrips_WithTheTauntInts()
    {
        var s = FightAt(4000);
        Sim.Step(ref s, Press(Sim.PressTaunt), 0);

        var packed = Sim.Pack(s);

        packed.Should().HaveCount(Sim.PackedLength);
        Sim.PackedLength.Should().Be(42);
        Sim.Unpack(packed).Should().Be(s);
    }

    // ── The golden fights: this copy against rollbackSim.js ───────────────────────────────
    // Each row: seed, final P1 hp, final P2 hp, winner, then the checksum every 400 frames of a
    // 4000-frame fight. Printed by scripts/dev/brawl-rollback-golden.mjs from the JavaScript copy;
    // a rule changed in one language and not the other fails here.
    public static readonly TheoryData<uint[]> Golden =
    [
        [1u, 33, 33, 0, 4100361270u, 3437562673u, 2770643749u, 1626905402u, 2190097442u, 2538221653u, 1242481658u, 187963231u, 319377936u, 4048845593u],
        [2026u, 62, 0, 1, 2856031101u, 1035117851u, 824434028u, 2054871608u, 1912688608u, 1716583897u, 785153833u, 4108126713u, 2225984585u, 1874649241u],
        [48879u, 22, 13, 1, 2213601414u, 2938568456u, 3623642222u, 4007978771u, 1535059477u, 2955999902u, 2229800840u, 3610841292u, 2713895409u, 504979666u],
        [777u, 0, 40, 2, 1115611545u, 3143762310u, 3124545343u, 326345822u, 1236235197u, 2008473244u, 2555457830u, 575291119u, 2320806111u, 2948659407u],
    ];

    // The script's presses, as the .mjs has them: every kind, grabs and taunts included.
    private static readonly int[] Presses =
    [
        Sim.PressNone, Sim.PressNone, Sim.PressPunch, Sim.PressKick, Sim.PressSpecial, Sim.PressGrab, Sim.PressTaunt, Sim.PressPunch,
        Sim.PressNone, Sim.PressNone, Sim.PressNone, Sim.PressGrab, Sim.PressNone, Sim.PressKick, Sim.PressNone, Sim.PressTaunt,
    ];

    private static int DrawInput(ref int script)
    {
        if (Sim.NextRandom(ref script) % 100u >= 12u) return 0;
        var held = (int)(Sim.NextRandom(ref script) % 4u);
        var press = Presses[(int)(Sim.NextRandom(ref script) % (uint)Presses.Length)];
        return Sim.EncodeInput(held, press);
    }

    [Theory]
    [MemberData(nameof(Golden))]
    public void GoldenFight_MatchesTheJavaScriptCopy_OnEverySampledFrame(uint[] row)
    {
        const int sampleEvery = 400;
        const int frames = 4000;
        var seed = row[0];
        var s = Sim.Create(seed, 30);
        var script = unchecked((int)(seed ^ 0x5bd1e995u));
        var sums = new List<uint>();

        for (var f = 1; f <= frames; f++)
        {
            var i1 = DrawInput(ref script);
            var i2 = DrawInput(ref script);
            Sim.Step(ref s, i1, i2);
            if (f % sampleEvery == 0) sums.Add(Sim.Checksum(s));
        }

        sums.Should().Equal(row.Skip(4), "the C# sim must reach the checksums rollbackSim.js printed");
        ((uint)s.P1.Hp).Should().Be(row[1]);
        ((uint)s.P2.Hp).Should().Be(row[2]);
        ((uint)s.Winner).Should().Be(row[3]);
    }
}
