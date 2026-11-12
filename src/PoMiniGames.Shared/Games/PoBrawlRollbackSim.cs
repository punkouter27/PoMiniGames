namespace PoMiniGames.Shared.Games;

/// <summary>
/// The online PoBrawl fight as a pure, integer-only, frame-stepped simulation: the rules
/// the server referees and both browsers predict with. It is implemented twice — here
/// and in <c>wwwroot/js/pobrawl/rollbackSim.js</c> — and the two must stay bit-identical:
/// the same <see cref="PoBrawlSimState"/> and the same inputs give the same next state and
/// the same <see cref="Checksum"/> in both languages (a golden script asserts it on each side).
/// </summary>
/// <remarks>
/// <para>
/// <b>Why 60 Hz.</b> It matches the display, so the presenter shows the newest frame
/// with no interpolation; input lands on a 16.7 ms grid instead of 33 ms; and a two-frame input
/// delay is the classic GGPO 33 ms. A step is a few dozen integer operations, so even a
/// two-second rollback (120 frames) costs well under a millisecond, and the network cost does
/// not change with the rate: inputs go out on change only and snapshots stay at 10 Hz.
/// </para>
/// <para>
/// <b>Units.</b> Positions are integer millimetres, energy is in sixths of a point
/// (<see cref="EnergyScale"/>, so the old 10 Hz regen of 1–2 points a tick is a whole number
/// per frame), and the damage roll uses mulberry32 seeded from the match id
/// (<see cref="SeedFromMatchId"/>). No floating point anywhere: a double that rounds one way
/// in .NET and the other in V8 is a desync.
/// </para>
/// <para>
/// <b>Inputs.</b> Per frame, each corner has at most one input event: the new HELD state
/// (Idle, MoveForward, MoveBack, Block — it persists in the state until the next event) and/or
/// an attack PRESS (buffered one deep behind the cooldown). "No event" is the prediction for a
/// corner whose input has not arrived: keep holding what it held, press nothing.
/// </para>
/// </remarks>
public static class PoBrawlRollbackSim
{
    /// <summary>Frames per second.</summary>
    public const int Hz = 60;

    /// <summary>Frames a client stamps its own input ahead of its current frame (GGPO's input delay).</summary>
    public const int InputDelayFrames = 2;

    /// <summary>Round length, frames (the 60 s bell).</summary>
    public const int RoundFrames = 60 * Hz;

    public const int MaxHp = 100;

    // ── Ring (millimetres) ────────────────────────────────────────────────
    /// <summary>Half-width of the ring (arena.js RING_HALF, 5.2 m).</summary>
    public const int RingHalfMm = 5200;
    /// <summary>Spawn distance from centre (game.js SPAWN_X_BY_SIDE): the fight opens 3.2 m apart.</summary>
    public const int SpawnXMm = 1600;
    /// <summary>Closest the corners can stand (game.js MIN_SEPARATION).</summary>
    public const int MinGapMm = 950;
    /// <summary>Walk per frame: 2.4 m/s in, 1.92 m/s out (the 10 Hz server's 2.4 / 1.9).</summary>
    public const int WalkInMm = 40;
    public const int WalkOutMm = 32;

    /// <summary>Largest gap at which each attack still connects.</summary>
    public const int PunchReachMm = 1500;
    public const int KickReachMm = 1750;
    public const int SpecialReachMm = 1750;

    /// <summary>How far a landed hit shoves the defender (halved through a guard).</summary>
    public const int PunchKnockbackMm = 150;
    public const int KickKnockbackMm = 450;
    public const int SpecialKnockbackMm = 900;

    // ── Timing (frames) ──────────────────────────────────────────────────
    /// <summary>Frames after a swing before that corner can swing again (0.3 / 0.5 / 0.8 s).</summary>
    public const int PunchCooldown = 18;
    public const int KickCooldown = 30;
    public const int SpecialCooldown = 48;

    // ── Energy (sub-units: <see cref="EnergyScale"/> per displayed point) ──
    public const int EnergyScale = 6;
    public const int EnergyMax = 100 * EnergyScale;
    /// <summary>Regen per frame: 20 points/s standing, 10 walking, none in a guard.</summary>
    public const int EnergyRegenIdle = 2;
    public const int EnergyRegenWalk = 1;
    public const int PunchEnergyCost = 3 * EnergyScale;
    public const int KickEnergyCost = 6 * EnergyScale;
    public const int EnergyOnHit = 6 * EnergyScale;

    // ── Damage ───────────────────────────────────────────────────────────
    public const int PunchDamage = 6;
    public const int KickDamage = 10;
    public const int SpecialDamage = 18;
    /// <summary>Each landed hit rolls ±this percent.</summary>
    public const int DamageVariancePct = 20;

    // ── Codes (the PoBrawlMatchAction values) ────────────────────────────
    public const int HeldIdle = 0, HeldForward = 1, HeldBack = 2, HeldBlock = 3;
    public const int PressNone = 0, PressPunch = 4, PressKick = 5, PressSpecial = 6;
    public const int OutcomeNone = 0, OutcomeHit = 1, OutcomeBlocked = 2, OutcomeWhiff = 3;
    public const int ReasonNone = 0, ReasonKo = 1, ReasonTime = 2;

    /// <summary>Length of <see cref="Pack"/>'s array (6 globals + 10 per corner).</summary>
    public const int PackedLength = 26;

    /// <summary>A fresh fight: both corners on their marks, <paramref name="fightStartFrame"/> frames of pre-roll.</summary>
    public static PoBrawlSimState Create(uint seed, int fightStartFrame) => new()
    {
        Frame = 0,
        FightStart = fightStartFrame,
        Rng = unchecked((int)seed),
        P1 = NewCorner(-SpawnXMm),
        P2 = NewCorner(SpawnXMm),
    };

    private static PoBrawlSimCorner NewCorner(int x) => new() { Hp = MaxHp, X = x, SwingFrame = -1 };

    /// <summary>FNV-1a over the id's UTF-16 code units — the same seed in .NET and JavaScript.</summary>
    public static uint SeedFromMatchId(string matchId)
    {
        var h = 2166136261u;
        foreach (var ch in matchId)
        {
            h = unchecked((h ^ ch) * 16777619u);
        }
        return h;
    }

    /// <summary>mulberry32: advances <paramref name="state"/> and returns the next 32 bits.</summary>
    public static uint NextRandom(ref int state)
    {
        unchecked
        {
            var a = (uint)state + 0x6D2B79F5u;
            state = (int)a;
            var t = (a ^ (a >> 15)) * (1u | a);
            t = (t + ((t ^ (t >> 7)) * (61u | t))) ^ t;
            return t ^ (t >> 14);
        }
    }

    /// <summary>
    /// One input event as an int: 0 = none; bits 0–2 hold held+1 (0 = unchanged), bits 3–5 the press.
    /// Pass <paramref name="held"/> = -1 for "press only, keep holding".
    /// </summary>
    public static int EncodeInput(int held, int press) => (held + 1) | (press << 3);

    public static int HeldOf(int input) => (input & 7) - 1;

    public static int PressOf(int input) => (input >> 3) & 7;

    /// <summary>Two events on one frame: the later one's held wins if it set one, and its press if it pressed.</summary>
    public static int MergeInput(int earlier, int later)
    {
        var held = (later & 7) != 0 ? later & 7 : earlier & 7;
        var press = PressOf(later) != 0 ? PressOf(later) : PressOf(earlier);
        return held | (press << 3);
    }

    /// <summary>Seconds since the bell (negative through the pre-roll).</summary>
    public static double ElapsedSeconds(in PoBrawlSimState s) => (s.Frame - s.FightStart) / (double)Hz;

    /// <summary>Advance one frame with each corner's input event (0 = none). A finished fight only counts frames.</summary>
    public static void Step(ref PoBrawlSimState s, int input1, int input2)
    {
        s.Frame++;
        if (s.Over != 0) return;
        ApplyInput(ref s.P1, input1);
        ApplyInput(ref s.P2, input2);

        // Pre-roll: held keys are remembered (a player already holding forward walks on the bell),
        // but nothing moves and a press made during the count is dropped.
        if (s.Frame <= s.FightStart)
        {
            s.P1.Pending = PressNone;
            s.P2.Pending = PressNone;
            return;
        }

        // 1. Swings, both against the START-of-frame gap, so neither side's knockback moves the
        //    other out of range first. Swinging drops the guard: you cannot attack and block at once.
        var gap = s.P2.X - s.P1.X;
        var a1 = TakeSwing(ref s.P1);
        var a2 = TakeSwing(ref s.P2);
        var p1Guarding = a1 == PressNone && s.P1.Held == HeldBlock;
        var p2Guarding = a2 == PressNone && s.P2.Held == HeldBlock;
        if (a1 != PressNone) ResolveSwing(ref s, a1, attackerIsP1: true, p2Guarding, gap);
        if (a2 != PressNone) ResolveSwing(ref s, a2, attackerIsP1: false, p1Guarding, gap);

        // 2. Footwork. A guard plants you; a swing roots you for its frame.
        if (a1 == PressNone) s.P1.X += WalkStep(s.P1.Held);
        if (a2 == PressNone) s.P2.X -= WalkStep(s.P2.Held);
        EnforceSpacing(ref s);

        // 3. Energy regen from what is held, and the cooldown clocks.
        Regen(ref s.P1);
        Regen(ref s.P2);

        // 4. The bell: a KO (P1 checked first, as the 10 Hz server did), else time — higher HP wins, a tie is a draw.
        if (s.P1.Hp <= 0)
        {
            s.Over = 1; s.Winner = 2; s.Reason = ReasonKo;
        }
        else if (s.P2.Hp <= 0)
        {
            s.Over = 1; s.Winner = 1; s.Reason = ReasonKo;
        }
        else if (s.Frame - s.FightStart >= RoundFrames)
        {
            s.Over = 1;
            s.Winner = s.P1.Hp > s.P2.Hp ? 1 : s.P2.Hp > s.P1.Hp ? 2 : 0;
            s.Reason = ReasonTime;
        }
    }

    private static void ApplyInput(ref PoBrawlSimCorner c, int input)
    {
        if (input == 0) return;
        var held = HeldOf(input);
        if (held is >= HeldIdle and <= HeldBlock) c.Held = held;
        var press = PressOf(input);
        if (press is >= PressPunch and <= PressSpecial) c.Pending = press;
    }

    private static int WalkStep(int held) => held switch
    {
        HeldForward => WalkInMm,
        HeldBack => -WalkOutMm,
        _ => 0,
    };

    private static void Regen(ref PoBrawlSimCorner c)
    {
        var regen = c.Held switch
        {
            HeldIdle => EnergyRegenIdle,
            HeldForward or HeldBack => EnergyRegenWalk,
            _ => 0,
        };
        c.Energy = Math.Min(EnergyMax, c.Energy + regen);
        if (c.Cooldown > 0) c.Cooldown--;
    }

    /// <summary>The buffered press, if this corner may swing this frame; consumes it, starts the cooldown, spends the energy.</summary>
    private static int TakeSwing(ref PoBrawlSimCorner c)
    {
        var swing = c.Pending;
        if (swing == PressNone || c.Cooldown > 0) return PressNone;
        c.Pending = PressNone;
        // A special without a full bar is simply refused; the press is spent.
        if (swing == PressSpecial && c.Energy < EnergyMax) return PressNone;
        switch (swing)
        {
            case PressPunch:
                c.Cooldown = PunchCooldown;
                c.Energy = Math.Max(0, c.Energy - PunchEnergyCost);
                break;
            case PressKick:
                c.Cooldown = KickCooldown;
                c.Energy = Math.Max(0, c.Energy - KickEnergyCost);
                break;
            default:
                c.Cooldown = SpecialCooldown;
                c.Energy = 0;
                break;
        }
        return swing;
    }

    private static void ResolveSwing(ref PoBrawlSimState s, int swing, bool attackerIsP1, bool guarded, int gap)
    {
        if (attackerIsP1) ResolveSwing(ref s.P1, ref s.P2, ref s.Rng, s.Frame, swing, guarded, gap, +1);
        else ResolveSwing(ref s.P2, ref s.P1, ref s.Rng, s.Frame, swing, guarded, gap, -1);
        EnforceSpacing(ref s);
    }

    private static void ResolveSwing(ref PoBrawlSimCorner attacker, ref PoBrawlSimCorner defender, ref int rng,
        int frame, int swing, bool guarded, int gap, int shoveDir)
    {
        int baseDmg, reach, knockback;
        switch (swing)
        {
            case PressPunch: baseDmg = PunchDamage; reach = PunchReachMm; knockback = PunchKnockbackMm; break;
            case PressKick: baseDmg = KickDamage; reach = KickReachMm; knockback = KickKnockbackMm; break;
            default: baseDmg = SpecialDamage; reach = SpecialReachMm; knockback = SpecialKnockbackMm; break;
        }
        attacker.SwingFrame = frame;
        attacker.Swing = swing;
        attacker.Damage = 0;
        if (gap > reach)
        {
            attacker.Outcome = OutcomeWhiff;
            return;
        }

        // ±20% (whole percent, round half up). Only a swing in reach rolls, so a whiff never moves the RNG.
        var variance = (int)(NextRandom(ref rng) % (uint)(2 * DamageVariancePct + 1)) - DamageVariancePct;
        var damage = (baseDmg * (100 + variance) + 50) / 100;

        // A guard negates a punch (the defensive read on a jab), chips a kick to a quarter (it still
        // shoves) and does nothing against the special. Knockback is halved through it.
        if (guarded)
        {
            damage = swing switch
            {
                PressPunch => 0,
                PressKick => Math.Max(1, damage / 4),
                _ => damage,
            };
            knockback /= 2;
        }

        // Shove the defender away (P1 is always the left corner).
        defender.X += shoveDir * knockback;

        // A guarded kick still chips, but it reads as a block on screen — the guard held.
        attacker.Outcome = guarded ? OutcomeBlocked : OutcomeHit;
        if (damage <= 0) return;
        var dealt = Math.Min(defender.Hp, damage);
        defender.Hp -= dealt;
        attacker.Damage = dealt;
        attacker.Energy = Math.Min(EnergyMax, attacker.Energy + EnergyOnHit);
    }

    /// <summary>Ring clamp, then the minimum gap, split between the corners (a corner pinned on the rope yields nothing).</summary>
    private static void EnforceSpacing(ref PoBrawlSimState s)
    {
        s.P1.X = Math.Clamp(s.P1.X, -RingHalfMm, RingHalfMm - MinGapMm);
        s.P2.X = Math.Clamp(s.P2.X, -RingHalfMm + MinGapMm, RingHalfMm);
        var deficit = MinGapMm - (s.P2.X - s.P1.X);
        if (deficit <= 0) return;
        var p1Room = s.P1.X + RingHalfMm;
        var p2Room = RingHalfMm - s.P2.X;
        var p1Share = Math.Min(p1Room, deficit / 2);
        var p2Share = Math.Min(p2Room, deficit - p1Share);
        p1Share = Math.Min(p1Room, deficit - p2Share);
        s.P1.X -= p1Share;
        s.P2.X += p2Share;
    }

    /// <summary>The state as the wire array (the layout rollbackSim.js unpacks).</summary>
    public static int[] Pack(in PoBrawlSimState s)
    {
        var a = new int[PackedLength];
        a[0] = s.Frame; a[1] = s.FightStart; a[2] = s.Rng; a[3] = s.Over; a[4] = s.Winner; a[5] = s.Reason;
        PackCorner(a, 6, s.P1);
        PackCorner(a, 16, s.P2);
        return a;
    }

    public static PoBrawlSimState Unpack(IReadOnlyList<int> a)
    {
        if (a.Count != PackedLength) throw new ArgumentException($"Expected {PackedLength} ints.", nameof(a));
        return new PoBrawlSimState
        {
            Frame = a[0],
            FightStart = a[1],
            Rng = a[2],
            Over = a[3],
            Winner = a[4],
            Reason = a[5],
            P1 = UnpackCorner(a, 6),
            P2 = UnpackCorner(a, 16),
        };
    }

    private static void PackCorner(int[] a, int o, in PoBrawlSimCorner c)
    {
        a[o] = c.Hp; a[o + 1] = c.Energy; a[o + 2] = c.X; a[o + 3] = c.Held; a[o + 4] = c.Pending;
        a[o + 5] = c.Cooldown; a[o + 6] = c.SwingFrame; a[o + 7] = c.Swing; a[o + 8] = c.Outcome; a[o + 9] = c.Damage;
    }

    private static PoBrawlSimCorner UnpackCorner(IReadOnlyList<int> a, int o) => new()
    {
        Hp = a[o],
        Energy = a[o + 1],
        X = a[o + 2],
        Held = a[o + 3],
        Pending = a[o + 4],
        Cooldown = a[o + 5],
        SwingFrame = a[o + 6],
        Swing = a[o + 7],
        Outcome = a[o + 8],
        Damage = a[o + 9],
    };

    /// <summary>FNV-1a over the packed ints (one 32-bit word at a time) — what a snapshot carries for desync detection.</summary>
    public static uint Checksum(in PoBrawlSimState s)
    {
        var h = 2166136261u;
        foreach (var v in Pack(s))
        {
            h = unchecked((h ^ (uint)v) * 16777619u);
        }
        return h;
    }
}

/// <summary>
/// The whole fight in 26 ints. A value type, so a copy is a clone and history is an array of them.
/// </summary>
#pragma warning disable CA1051 // Value-type rollback snapshot mutates fields directly for zero-alloc simulation.
public struct PoBrawlSimState : IEquatable<PoBrawlSimState>
{
    /// <summary>Frames stepped since the match was created.</summary>
    public int Frame;
    /// <summary>Last frame of the pre-roll; the bell rings on the frame after it.</summary>
    public int FightStart;
    /// <summary>The mulberry32 state.</summary>
    public int Rng;
    /// <summary>1 once the fight is decided by the rules (a KO or the bell). A forfeit is the server's, not the sim's.</summary>
    public int Over;
    /// <summary>0 = none or draw, 1 = P1, 2 = P2.</summary>
    public int Winner;
    /// <summary><see cref="PoBrawlRollbackSim.ReasonKo"/> or <see cref="PoBrawlRollbackSim.ReasonTime"/>.</summary>
    public int Reason;
    public PoBrawlSimCorner P1;
    public PoBrawlSimCorner P2;

    public readonly bool Equals(PoBrawlSimState other) =>
        PoBrawlRollbackSim.Pack(this).AsSpan().SequenceEqual(PoBrawlRollbackSim.Pack(other));

    public override readonly bool Equals(object? obj) => obj is PoBrawlSimState s && Equals(s);

    public override readonly int GetHashCode() => (int)PoBrawlRollbackSim.Checksum(this);

    public static bool operator ==(PoBrawlSimState a, PoBrawlSimState b) => a.Equals(b);

    public static bool operator !=(PoBrawlSimState a, PoBrawlSimState b) => !a.Equals(b);
}

/// <summary>One corner of <see cref="PoBrawlSimState"/>.</summary>
public struct PoBrawlSimCorner
{
    public int Hp;
    /// <summary>Sub-units: <see cref="PoBrawlRollbackSim.EnergyScale"/> per displayed point, full at <see cref="PoBrawlRollbackSim.EnergyMax"/>.</summary>
    public int Energy;
    /// <summary>Millimetres from the ring centre (negative = left). P1 is always left of P2.</summary>
    public int X;
    /// <summary>Idle / forward / back / block (PoBrawlMatchAction 0–3).</summary>
    public int Held;
    /// <summary>A pressed attack waiting for the cooldown (4–6), or 0.</summary>
    public int Pending;
    public int Cooldown;
    // ── The most recent swing, for the 3D view: the presenter throws each (side, frame) once ──
    /// <summary>Frame the latest swing fired on, or -1 before the first.</summary>
    public int SwingFrame;
    public int Swing;
    public int Outcome;
    /// <summary>Damage that swing dealt (0 for a block or a whiff).</summary>
    public int Damage;
}
