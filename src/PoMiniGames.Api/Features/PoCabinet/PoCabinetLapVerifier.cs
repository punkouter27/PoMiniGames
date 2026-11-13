using System.Buffers.Binary;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Server-side proof for a solo best lap. The browser runs solo races itself, so a
/// bare "my best lap was 31.2 s" is just a number anyone can POST. Instead the page sends the
/// player's controls for every race tick and this class re-runs the whole race — the player
/// plus all 63 rivals, contacts included — through <see cref="PoCabinetPhysics"/> and
/// <see cref="PoCabinetAiDriver"/>. The lap time that gets stored is the one computed here.
///
/// <para>
/// <b>Mirror contract:</b> <see cref="Replay"/> is <c>race.js</c> <c>buildSoloCars</c> +
/// <c>soloTick</c> + <c>lapBookkeeping</c>: same grid (player id 0 in
/// <see cref="PoCabinetCatalog.SoloPlayerSlot"/>, the rivals of
/// <see cref="PoCabinetPersonality.SoloField"/> in order round it), same car order for
/// contacts, same clock arithmetic
/// (<c>clock += TICK</c>, <c>tickStart = max(0, elapsed − TICK)</c>). The page quantizes the
/// player's controls to thousandths <i>before</i> stepping them, so the recorded integers are
/// exactly what the browser simulated. Damage is in the replay too (it is physics state): the
/// log ends where the player's car was wrecked, and a wrecked car counts no more laps.
/// JS and .NET trig can still differ in the last ulp, so
/// the replay is not bit-identical — which is why the stored time is the server's, never the
/// claim.
/// </para>
/// <para>
/// What this does not prove: that a human drove it. A bot that emits a legal input stream
/// sets a legal lap. It does rule out every lap the physics cannot produce.
/// </para>
/// </summary>
public static class PoCabinetLapVerifier
{
    /// <summary>race.js <c>MAX_RECORD_FRAMES</c>: eight minutes of ticks.</summary>
    private const int MaxTicks = 30 * 60 * 8;
    private const int BytesPerTick = 6;
    /// <summary>race.js: solo rain grip (<c>currentEnvironment().raining ? 0.85 : 1</c>).</summary>
    public const double WetGrip = 0.85;
    private const double Countdown = 3;

    /// <summary>
    /// Decode a base64 input log: per race tick, three little-endian int16s — throttle and
    /// brake in [0, 1000], steer in [-1000, 1000]. Null when malformed or too long.
    /// </summary>
    public static PoCabinetControls[]? Decode(string? base64)
    {
        if (string.IsNullOrEmpty(base64) || base64.Length > (MaxTicks * BytesPerTick + 2) / 3 * 4) return null;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(base64); }
        catch (FormatException) { return null; }
        if (bytes.Length == 0 || bytes.Length % BytesPerTick != 0) return null;

        var ticks = new PoCabinetControls[bytes.Length / BytesPerTick];
        for (int i = 0; i < ticks.Length; i++)
        {
            var span = bytes.AsSpan(i * BytesPerTick);
            short t = BinaryPrimitives.ReadInt16LittleEndian(span);
            short b = BinaryPrimitives.ReadInt16LittleEndian(span[2..]);
            short s = BinaryPrimitives.ReadInt16LittleEndian(span[4..]);
            if (t is < 0 or > 1000 || b is < 0 or > 1000 || s is < -1000 or > 1000) return null;
            ticks[i] = new PoCabinetControls(t / 1000.0, b / 1000.0, s / 1000.0);
        }
        return ticks;
    }

    /// <summary>
    /// Re-run a solo race with the recorded controls: the player's best completed lap in seconds
    /// (-1 when the inputs never complete one) and their place when the log ends (at their
    /// finish, or at their wreck): finishers by finish order, then everyone by race distance.
    /// </summary>
    public static PoCabinetReplay Replay(string trackId, bool wet, IReadOnlyList<PoCabinetControls> inputs)
    {
        var track = PoCabinetTrack.Get(trackId);
        double grip = wet ? WetGrip : 1;
        double tick = PoCabinetPhysics.TickSeconds;
        int totalLaps = track.Laps;
        int finishOrder = 0;

        var cars = new List<Car>();
        var player = new Car { IsPlayer = true };
        PoCabinetPhysics.SetStyle(player, 0);
        PoCabinetPhysics.GridSlot(track, player, PoCabinetCatalog.SoloPlayerSlot);
        cars.Add(player);
        var field = PoCabinetPersonality.SoloField;
        for (int i = 0; i < field.Count; i++)
        {
            var o = field[i];
            var car = new Car { Persona = o.Personality, MaxSpeed = o.MaxSpeed, CorneringSkill = o.CorneringSkill };
            PoCabinetPhysics.SetStyle(car, i + 1);
            PoCabinetPhysics.GridSlot(track, car, i < PoCabinetCatalog.SoloPlayerSlot ? i : i + 1);
            cars.Add(car);
        }
        PoCabinetCarBody[] bodies = [.. cars];

        double clock = 0;
        int used = 0;
        while (used < inputs.Count && !player.Finished && !player.Wrecked)
        {
            clock += tick;
            double elapsed = clock - Countdown;
            if (elapsed < 0) continue;
            double tickStart = Math.Max(0, elapsed - tick);
            double stepDt = elapsed - tickStart;
            var controls = inputs[used++];
            var cond = new PoCabinetConditions(wet, PoCabinetTrack.RubberAt(elapsed));

            foreach (var car in cars)
            {
                car.PrevDistance = car.Distance;
                var c = car.IsPlayer
                    ? controls
                    : PoCabinetAiDriver.Decide(track, car, car.Persona!, car.Finished ? car.MaxSpeed * track.CoolDownAt(car.Distance) : car.MaxSpeed,
                        car.CorneringSkill, bodies, grip);
                PoCabinetPhysics.Step(track, car, c, stepDt, grip, cond);
            }
            PoCabinetPhysics.ResolveContacts(track, bodies);

            foreach (var car in cars)
            {
                bool running = !car.Finished;
                car.CountLaps(track, tickStart, stepDt, totalLaps);
                if (running && car.Finished) car.FinishOrder = ++finishOrder;
            }
        }
        // A wreck is a DNF, classified behind every car still running (race.js ranks the same).
        int place = 1 + cars.Count(c => c != player && (c.Finished
            ? !player.Finished || c.FinishOrder < player.FinishOrder
            : !player.Finished && (c.Wrecked != player.Wrecked ? player.Wrecked : c.Distance > player.Distance)));
        return new PoCabinetReplay(player.BestLapSeconds > 0 ? player.BestLapSeconds : -1, place);
    }

    private sealed class Car : PoCabinetRacer
    {
        public bool IsPlayer { get; init; }
        public PoCabinetPersonality? Persona { get; init; }
        public double MaxSpeed { get; init; } = PoCabinetPhysics.MaxSpeed;
        public double CorneringSkill { get; init; } = 0.7;
        public int FinishOrder { get; set; }
    }
}

/// <summary>What <see cref="PoCabinetLapVerifier.Replay"/> found: the best lap (-1 = none) and the player's place.</summary>
public readonly record struct PoCabinetReplay(double BestLapSeconds, int Position);
