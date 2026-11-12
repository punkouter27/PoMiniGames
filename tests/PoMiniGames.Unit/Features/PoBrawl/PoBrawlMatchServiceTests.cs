using System.Diagnostics;
using System.Reflection;
using System.Text.Json;
using System.Text.RegularExpressions;
using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Features.PoBrawl.Online;
using PoMiniGames.Shared.Games;
using Sim = PoMiniGames.Shared.Games.PoBrawlRollbackSim;

namespace PoMiniGames.Unit.Features.PoBrawl;

/// <summary>
/// The live 1v1 referee and its shared rollback sim: side pinning, the input timeline (re-stamping,
/// never into the past), range-gated damage, deterministic rolls, finish conditions, presence,
/// the result payload, and the cross-language golden script.
/// </summary>
/// <remarks>
/// One <c>[Theory]</c> of named scenarios so the Unit tier stays under its 100-method ceiling.
/// The ring has spacing: the corners open 3.2 m apart, out of every attack's reach, so each
/// scenario that wants a hit walks in first (<see cref="CloseIn"/>).
/// </remarks>
public class PoBrawlMatchServiceTests
{
    private static readonly string[] ExpectedConnIds = ["conn-1", "conn-2"];
    // ── The golden script — must match tests/pobrawl-rollback.test.mjs (GOLDEN) ──
    private static readonly JsonElement Contract =
        JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "pobrawl-rollback-golden.json"))).RootElement;
    private static readonly JsonElement Golden = Contract.GetProperty("golden");
    private static readonly string GoldenMatchId = Golden.GetProperty("matchId").GetString()!;
    private static readonly int[] GoldenHeldPick = [.. Golden.GetProperty("heldPick").EnumerateArray().Select(e => e.GetInt32())];
    private static readonly int[] GoldenPressPick = [.. Golden.GetProperty("pressPick").EnumerateArray().Select(e => e.GetInt32())];

    private long _seq;

    private static PoBrawlLobbyPlayer NewPlayer(string connId, string principal, string name, PoBrawlFighter fighter) =>
        new(connId, principal, name, IsGuest: false, IsReady: true, fighter);

    private static PoBrawlMatchService StartedMatch(string matchId = "test-match", double countdownSeconds = 0)
    {
        var alice = NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob);
        var bob = NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob);
        var match = new PoBrawlMatchService(matchId, "BRAWL", new[] { alice, bob }, countdownSeconds);
        match.RegisterConnection("conn-1", PoBrawlSide.Player1);
        match.RegisterConnection("conn-2", PoBrawlSide.Player2);
        return match;
    }

    /// <summary>One input for the next frame (or <paramref name="frame"/>): a held state and an optional press.</summary>
    private PoBrawlMatchInputEvent? Send(PoBrawlMatchService match, string conn, PoBrawlMatchAction held,
        PoBrawlMatchAction press = PoBrawlMatchAction.Idle, PoBrawlSide claimed = PoBrawlSide.Player1, long? frame = null) =>
        match.SubmitInput(conn, new PoBrawlMatchInput
        {
            ActorSide = claimed,
            Frame = frame ?? match.Frame + 1,
            Held = held,
            Press = press,
            Sequence = ++_seq,
        });

    private static int Gap(PoBrawlMatchService match) => match.SimState.P2.X - match.SimState.P1.X;

    /// <summary>Walk <paramref name="conn"/> forward until the gap is inside punch reach, then stop.</summary>
    private void CloseIn(PoBrawlMatchService match, string conn)
    {
        Send(match, conn, PoBrawlMatchAction.MoveForward);
        match.Step();
        for (var i = 0; i < 400 && Gap(match) > Sim.PunchReachMm - 100; i++) match.Step();
        Send(match, conn, PoBrawlMatchAction.Idle);
        match.Step();
    }

    /// <summary>Close in, then walk in and press <paramref name="attack"/> every frame until the match ends.</summary>
    private PoBrawlMatchState? FightToKo(PoBrawlMatchService match, string conn, PoBrawlMatchAction attack)
    {
        CloseIn(match, conn);
        PoBrawlMatchState? snap = null;
        for (var frame = 0; frame < 6000; frame++)
        {
            // Knockback opens the gap, so keep walking back into range between swings.
            Send(match, conn, PoBrawlMatchAction.MoveForward, attack);
            snap = match.Step();
            if (snap is { Finished: true }) break;
        }
        return snap;
    }

    /// <summary>
    /// Each row runs one scenario: a private method below, named after what it checks.
    /// </summary>
    [Theory]
    [InlineData(nameof(Step_LandsOnlyInRange_OncePerPress_AndBlockNegatesPunch))]
    [InlineData(nameof(SubmitInput_OverridesActorWithPinnedSide))]
    [InlineData(nameof(Step_AppliesDamageDeterministically_PerMatchId))]
    [InlineData(nameof(Step_FinishesByKo_ThenReturnsNull_AndRejectsFurtherInputs))]
    [InlineData(nameof(Lifecycle_PreRoll_SwingReport_Forfeit_AndArrival))]
    [InlineData(nameof(BuildResultFor_ShapesOutcomePerConnection))]
    [InlineData(nameof(Timeline_RestampsLateInputs_NeverRewritesThePast_AndKeepsEachSideInOrder))]
    [InlineData(nameof(Snapshot_CarriesThePackedSimAndItsChecksum))]
    [InlineData(nameof(GoldenScript_MatchesTheJavaScriptSim_AndTheRefereeAppliesIt))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private void Step_LandsOnlyInRange_OncePerPress_AndBlockNegatesPunch()
    {
        // 1. Out of range: the fight opens 3.2 m apart, so a punch from spawn whiffs.
        var far = StartedMatch("far");
        Send(far, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Punch);
        var whiff = far.Step()!;
        whiff.Player2Hp.Should().Be(100, "a jab thrown from across the ring must not land");
        far.SimState.P1.Outcome.Should().Be(Sim.OutcomeWhiff);

        // 2. In range, a single press lands exactly once.
        var near = StartedMatch("near");
        CloseIn(near, "conn-1");
        Send(near, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Punch);
        var landed = near.Step()!;
        landed.Player2Hp.Should().BeLessThan(100);
        for (var i = 0; i < 60; i++) near.Step();
        near.Step()!.Player2Hp.Should().Be(landed.Player2Hp, "one press is one swing");

        // 3. A held guard negates a punch in range.
        var guard = StartedMatch("guard");
        CloseIn(guard, "conn-1");
        Send(guard, "conn-2", PoBrawlMatchAction.Block);
        Send(guard, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Punch);
        var blocked = guard.Step()!;
        blocked.Player2Hp.Should().Be(100, "punch is fully negated by a block");
        guard.SimState.P1.Outcome.Should().Be(Sim.OutcomeBlocked);
    }

    private void SubmitInput_OverridesActorWithPinnedSide()
    {
        var match = StartedMatch();
        // Malicious: conn-1 (P1) claims to be P2 and walks. The server pins it to P1, so
        // it is P1's corner that moves — P2's must not budge.
        var accepted = Send(match, "conn-1", PoBrawlMatchAction.MoveForward, claimed: PoBrawlSide.Player2);
        accepted!.Side.Should().Be(PoBrawlSide.Player1, "the echo names the pinned side");
        var snap = match.Step()!;
        snap.Player1X.Should().BeGreaterThan(-1.6, "the pinned side (P1) walked");
        snap.Player2X.Should().Be(1.6, "the claimed side (P2) must be untouched");
        // Someone with no seat (a spectator) moves nobody.
        match.SubmitInput("spectator", new PoBrawlMatchInput { Held = PoBrawlMatchAction.MoveForward, Frame = match.Frame + 1, Sequence = ++_seq })
            .Should().BeNull();
    }

    private void Step_AppliesDamageDeterministically_PerMatchId()
    {
        var hp = new List<int>();
        foreach (var m in new[] { StartedMatch("dup-match"), StartedMatch("dup-match") })
        {
            CloseIn(m, "conn-1");
            for (var i = 0; i < 5; i++)
            {
                Send(m, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Punch);
                for (var t = 0; t < Sim.PunchCooldown; t++) m.Step();
            }
            hp.Add(m.Step()!.Player2Hp);
        }
        hp[0].Should().BeLessThan(100);
        hp[0].Should().Be(hp[1], "same match id + same inputs must roll the same damage");
    }

    private void Step_FinishesByKo_ThenReturnsNull_AndRejectsFurtherInputs()
    {
        var match = StartedMatch();
        var final = FightToKo(match, "conn-2", PoBrawlMatchAction.Kick);
        final.Should().NotBeNull();
        final!.Finished.Should().BeTrue();
        final.Winner.Should().Be(PoBrawlSide.Player2);
        final.LastEvent.Should().Be("ko");
        // Once finished, further steps report null so the pump stops broadcasting.
        match.Step().Should().BeNull();
        match.AdvanceTo(match.Frame + 100).Should().Be(0);
        // Post-finish: SubmitInput is refused so a stale client cannot keep firing hits.
        Send(match, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Special).Should().BeNull();
    }

    /// <summary>
    /// The match lifecycle in one scenario: the pre-roll holds the fight, each swing is recorded in
    /// the sim (the 3D view throws exactly that), a corner that stays away forfeits — the server
    /// letting go of its keys on the way — the clock waits for both corners, and a corner that never
    /// arrives abandons the fight instead of handing the other a win.
    /// </summary>
    private void Lifecycle_PreRoll_SwingReport_Forfeit_AndArrival()
    {
        // Pre-roll (1 s = 60 frames): nothing moves and a press made during the count is dropped.
        var counted = StartedMatch("count", countdownSeconds: 1);
        Send(counted, "conn-1", PoBrawlMatchAction.MoveForward, PoBrawlMatchAction.Kick);
        var pre = counted.Step()!;
        pre.ElapsedSeconds.Should().BeLessThan(0);
        pre.Player1X.Should().Be(-1.6, "the count holds everyone on their marks");
        counted.AdvanceTo(Sim.Hz + 1).Should().Be(Sim.Hz);
        var live = counted.Snapshot();
        live.Player1X.Should().BeGreaterThan(-1.6, "a key held through the count walks on the bell");
        counted.SimState.P1.SwingFrame.Should().Be(-1, "the kick pressed during the count was dropped");

        // Swing report: the corner, the attack, the outcome and the exact damage dealt.
        var match = StartedMatch("report");
        CloseIn(match, "conn-1");
        Send(match, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Punch);
        var hit = match.Step()!;
        var p1 = match.SimState.P1;
        p1.Swing.Should().Be((int)PoBrawlMatchAction.Punch);
        p1.SwingFrame.Should().Be((int)hit.Frame);
        p1.Outcome.Should().Be(Sim.OutcomeHit);
        p1.Damage.Should().Be(100 - hit.Player2Hp);
        match.SimState.P2.SwingFrame.Should().Be(-1);

        // Forfeit: P2 (walking) drops and never comes back. The server lets go of its keys with an
        // input of its own, which the hub broadcasts like any other.
        Send(match, "conn-2", PoBrawlMatchAction.MoveBack);
        var released = match.UnregisterConnection("conn-2");
        released.Should().NotBeNull();
        released!.Side.Should().Be(PoBrawlSide.Player2);
        released.Held.Should().Be(PoBrawlMatchAction.Idle);
        released.Sequence.Should().Be(0, "a server-made input carries no client sequence");
        PoBrawlMatchState? end = null;
        for (var i = 0; i < (PoBrawlMatchService.ReconnectGraceSeconds + 1) * Sim.Hz && end is not { Finished: true }; i++)
            end = match.Step();
        end!.Finished.Should().BeTrue();
        end.LastEvent.Should().Be("forfeit");
        end.Winner.Should().Be(PoBrawlSide.Player1);
        end.Player2Held.Should().Be(PoBrawlMatchAction.Idle, "the dropped corner stopped walking");
        match.BuildResultFor("conn-1").Forfeit.Should().BeTrue();

        match.BuildResultFor("conn-1").Abandoned.Should().BeFalse("both corners fought before the drop");

        // Arrival: the clock (and with it the countdown) is held until the second corner joins.
        var later = Stopwatch.GetTimestamp() + 10 * Stopwatch.Frequency;
        var waiting = new PoBrawlMatchService("wait", "BRAWL",
            new[] { NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob), NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob) }, 1);
        waiting.RegisterConnection("conn-1", PoBrawlSide.Player1);
        waiting.IsWaiting.Should().BeTrue();
        waiting.ClockFrame(later).Should().Be(0, "nobody is fighting yet");
        waiting.AdvanceToClock(later).Should().Be(0);
        waiting.Snapshot().WaitingForOpponent.Should().BeTrue();
        waiting.Snapshot().ForfeitInSeconds.Should().BePositive("the corner that is here sees the arrival countdown");
        waiting.RegisterConnection("conn-2", PoBrawlSide.Player2);
        waiting.IsWaiting.Should().BeFalse();
        waiting.ClockFrame(Stopwatch.GetTimestamp() + Stopwatch.Frequency).Should().BeApproximately(Sim.Hz, 6,
            "the clock runs from the second arrival, not from the lobby's start");
        waiting.AdvanceToClock(Stopwatch.GetTimestamp() + Stopwatch.Frequency / 2).Should().BeGreaterThan(0);
        waiting.Snapshot().ElapsedSeconds.Should().BeLessThan(0, "the full pre-roll is still to come");

        // A corner that never arrives: the fight is abandoned, never a win for the one who came.
        var noShow = new PoBrawlMatchService("noshow", "BRAWL",
            new[] { NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob), NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob) }, 1);
        noShow.RegisterConnection("conn-1", PoBrawlSide.Player1);
        var pastGrace = Stopwatch.GetTimestamp() + (long)((PoBrawlMatchService.ArrivalGraceSeconds + 1) * Stopwatch.Frequency);
        noShow.AdvanceToClock(pastGrace).Should().Be(0);
        noShow.FinishedAtUtc.Should().NotBeNull();
        var abandoned = noShow.Snapshot();
        abandoned.LastEvent.Should().Be("abandoned");
        abandoned.Winner.Should().BeNull("a corner that never arrived is never beaten by forfeit");
        var result = noShow.BuildResultFor("conn-1");
        result.Abandoned.Should().BeTrue();
        result.Outcome.Should().Be(PoBrawlOutcome.Draw);

        // The same through the referee's own presence clock (a sim stepped with a corner never seen).
        var stepped = new PoBrawlMatchService("stepped", "BRAWL",
            new[] { NewPlayer("conn-1", "alice", "Alice", PoBrawlRoster.Bob), NewPlayer("conn-2", "bob", "Bob", PoBrawlRoster.Bob) });
        stepped.RegisterConnection("conn-1", PoBrawlSide.Player1);
        PoBrawlMatchState? last = null;
        for (var i = 0; i < (PoBrawlMatchService.ArrivalGraceSeconds + 1) * Sim.Hz && last is not { Finished: true }; i++)
            last = stepped.Step();
        last!.LastEvent.Should().Be("abandoned");
        last.Winner.Should().BeNull();
    }

    private void BuildResultFor_ShapesOutcomePerConnection()
    {
        var match = StartedMatch();
        FightToKo(match, "conn-2", PoBrawlMatchAction.Punch);
        var p1Result = match.BuildResultFor("conn-1");
        var p2Result = match.BuildResultFor("conn-2");
        p1Result.LocalSide.Should().Be(PoBrawlSide.Player1);
        p1Result.Outcome.Should().Be(PoBrawlOutcome.Loss);
        p2Result.LocalSide.Should().Be(PoBrawlSide.Player2);
        p2Result.Outcome.Should().Be(PoBrawlOutcome.Win);
        p1Result.OpponentId.Should().Be("bob");
        p2Result.OpponentId.Should().Be("alice");
        // The pump sends results to these, not to the lobby roster's connection ids.
        match.ConnectionIds.Should().BeEquivalentTo(ExpectedConnIds);
    }

    /// <summary>
    /// The server is the timeline authority: an input stamped for a frame it has already simulated
    /// lands on the next one (and the echo says so), a future stamp is honoured exactly, a side's
    /// inputs never reorder, an absurd lead is pulled in, and stale or malformed inputs are refused.
    /// </summary>
    private void Timeline_RestampsLateInputs_NeverRewritesThePast_AndKeepsEachSideInOrder()
    {
        var match = StartedMatch("timeline");
        match.AdvanceTo(5).Should().Be(5);

        var late = Send(match, "conn-1", PoBrawlMatchAction.MoveForward, frame: 2)!;
        late.Frame.Should().Be(6, "frame 2 is the server's past: it lands on serverFrame + 1");
        late.Sequence.Should().Be(_seq, "the echo carries the sender's sequence so it can find its own input");
        late.MatchId.Should().Be("timeline");

        var future = Send(match, "conn-2", PoBrawlMatchAction.MoveBack, frame: 20)!;
        future.Frame.Should().Be(20, "a future stamp is honoured exactly");
        var reordered = Send(match, "conn-2", PoBrawlMatchAction.Block, PoBrawlMatchAction.Kick, frame: 10)!;
        reordered.Frame.Should().Be(20, "a side's later input never lands before its earlier one");

        match.Step();
        match.SimState.P1.Held.Should().Be(Sim.HeldForward, "the re-stamped input applied on frame 6");
        match.AdvanceTo(19);
        match.SimState.P2.Held.Should().Be(Sim.HeldIdle, "nothing of P2's has happened before frame 20");
        match.Step();
        match.SimState.P2.Held.Should().Be(Sim.HeldBlock, "two inputs on one frame merge: the later held wins");
        match.SimState.P2.SwingFrame.Should().Be(20, "and its press fires (a whiff from across the ring)");

        Send(match, "conn-1", PoBrawlMatchAction.Idle, frame: 1_000_000)
            .Should().BeNull("a stamp far past the lead window is refused, not honoured");
        Send(match, "conn-1", PoBrawlMatchAction.Idle, frame: match.Frame + PoBrawlMatchService.MaxInputLeadFrames)!.Frame
            .Should().Be(match.Frame + PoBrawlMatchService.MaxInputLeadFrames, "the edge of the lead window still lands");

        // Flooding: a corner gets MaxInputsPerFrame on one frame, and MaxInputsPerSecond a second.
        var flood = StartedMatch("flood");
        var target = flood.Frame + 10;
        Enumerable.Range(0, PoBrawlMatchService.MaxInputsPerFrame + 2)
            .Count(_ => Send(flood, "conn-1", PoBrawlMatchAction.Block, frame: target) is not null)
            .Should().Be(PoBrawlMatchService.MaxInputsPerFrame, "inputs on one frame merge, so more are only work");
        Enumerable.Range(0, 100)
            .Count(i => Send(flood, "conn-2", PoBrawlMatchAction.Idle, frame: flood.Frame + 1 + i) is not null)
            .Should().Be(PoBrawlMatchService.MaxInputsPerSecond, "a second of fight takes at most this many from a corner");
        flood.AdvanceTo(flood.Frame + Sim.Hz);
        Send(flood, "conn-2", PoBrawlMatchAction.Idle).Should().NotBeNull("the budget refills as the fight moves on");
        match.SubmitInput("conn-1", new PoBrawlMatchInput { Held = PoBrawlMatchAction.Idle, Frame = match.Frame + 1, Sequence = 1 })
            .Should().BeNull("a sequence number that is not newer is stale");
        match.SubmitInput("conn-2", new PoBrawlMatchInput { Held = PoBrawlMatchAction.Punch, Frame = match.Frame + 1, Sequence = ++_seq })
            .Should().BeNull("an attack is not a held state");
        match.SubmitInput("conn-2", new PoBrawlMatchInput { Held = PoBrawlMatchAction.Idle, Press = PoBrawlMatchAction.MoveBack, Frame = match.Frame + 1, Sequence = ++_seq })
            .Should().BeNull("walking is not a press");

        // A refresh is a new connection with its own sequence numbers: they start over and are accepted.
        match.RegisterConnection("conn-1b", PoBrawlSide.Player1);
        match.SubmitInput("conn-1b", new PoBrawlMatchInput { Held = PoBrawlMatchAction.Idle, Frame = match.Frame + 1, Sequence = 1 })
            .Should().NotBeNull();
    }

    private void Snapshot_CarriesThePackedSimAndItsChecksum()
    {
        var match = StartedMatch("snap");
        CloseIn(match, "conn-1");
        Send(match, "conn-1", PoBrawlMatchAction.Idle, PoBrawlMatchAction.Kick);
        var snap = match.Step()!;
        snap.Sim.Should().HaveCount(Sim.PackedLength);
        var unpacked = Sim.Unpack(snap.Sim);
        unpacked.Should().Be(match.SimState);
        (unpacked == match.SimState).Should().BeTrue();
        snap.Frame.Should().Be(unpacked.Frame);
        snap.Checksum.Should().Be(Sim.Checksum(unpacked));
        snap.Player2Hp.Should().Be(unpacked.P2.Hp);
        snap.Player1Energy.Should().Be(unpacked.P1.Energy / Sim.EnergyScale);
        var copy = unpacked;
        copy.P2.Cooldown++;
        (copy != unpacked).Should().BeTrue("a struct copy is a clone");
        Sim.Checksum(copy).Should().NotBe(snap.Checksum, "the checksum sees every field");
    }

    private static int GoldenEvent(ref int script)
    {
        var r = Sim.NextRandom(ref script);
        if (r % 11 != 0) return 0;
        return Sim.EncodeInput(GoldenHeldPick[(r >> 3) % 6], GoldenPressPick[(r >> 11) % 8]);
    }

    /// <summary>
    /// Cross-language determinism: every rule constant and the golden script's final state match
    /// tests/pobrawl-rollback-golden.json, the contract tests/pobrawl-rollback.test.mjs holds the
    /// JS sim to, and the referee fed the same script as frame-stamped inputs arrives at the very
    /// same state.
    /// </summary>
    private void GoldenScript_MatchesTheJavaScriptSim_AndTheRefereeAppliesIt()
    {
        var tuning = typeof(Sim).GetFields(BindingFlags.Public | BindingFlags.Static)
            .Where(f => f.IsLiteral)
            .ToDictionary(f => Regex.Replace(f.Name, "(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_").ToUpperInvariant(),
                f => (int)f.GetRawConstantValue()!);
        var expected = Contract.GetProperty("tuning").EnumerateObject().ToDictionary(p => p.Name, p => p.Value.GetInt32());
        tuning.Should().BeEquivalentTo(expected, "the C# and JS sims share one rulebook");

        var fightStart = Golden.GetProperty("fightStart").GetInt32();
        var goldenChecksum = Golden.GetProperty("checksum").GetUInt32();
        Sim.SeedFromMatchId(GoldenMatchId).Should().Be(Golden.GetProperty("seed").GetUInt32());
        var s = Sim.Create(Sim.SeedFromMatchId(GoldenMatchId), fightStart);
        var script = Golden.GetProperty("scriptSeed").GetInt32();
        var events = new List<(int Frame, int P1, int P2)>();
        while (s.Over == 0 && s.Frame < fightStart + Sim.RoundFrames + 10)
        {
            var e1 = GoldenEvent(ref script);
            var e2 = GoldenEvent(ref script);
            events.Add((s.Frame + 1, e1, e2));
            Sim.Step(ref s, e1, e2);
        }
        s.Frame.Should().Be(Golden.GetProperty("frame").GetInt32());
        Sim.Checksum(s).Should().Be(goldenChecksum);
        (s.P1.Hp, s.P2.Hp, s.Reason, s.Winner).Should().Be((Golden.GetProperty("p1Hp").GetInt32(), Golden.GetProperty("p2Hp").GetInt32(),
            Golden.GetProperty("reason").GetInt32(), Golden.GetProperty("winner").GetInt32()));

        // The referee: the same script, sent as inputs stamped for their frames, half a second of pre-roll.
        var match = StartedMatch(GoldenMatchId, countdownSeconds: 0.5);
        foreach (var (frame, p1, p2) in events)
        {
            foreach (var (conn, input) in new[] { ("conn-1", p1), ("conn-2", p2) })
            {
                if (input == 0) continue;
                Send(match, conn, (PoBrawlMatchAction)Sim.HeldOf(input), (PoBrawlMatchAction)Sim.PressOf(input), frame: frame)!
                    .Frame.Should().Be(frame);
            }
            match.Step();
        }
        Sim.Checksum(match.SimState).Should().Be(goldenChecksum);
        match.Snapshot().LastEvent.Should().Be("ko");
    }
}
