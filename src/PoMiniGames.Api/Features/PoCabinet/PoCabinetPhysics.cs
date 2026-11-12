using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>Resolved per-tick controls: throttle and brake in [0, 1], steer in [-1, 1] (+ = right).</summary>
public readonly record struct PoCabinetControls(double Throttle, double Brake, double Steer)
{
    /// <summary>A player's analog input, clamped; no input coasts.</summary>
    public static PoCabinetControls From(PoCabinetInput? input) => input is null ? default : new PoCabinetControls(
        Clamp01(input.Throttle),
        Clamp01(input.Brake),
        Math.Clamp(double.IsFinite(input.Steer) ? input.Steer : 0, -1, 1));

    private static double Clamp01(double v) => double.IsFinite(v) ? Math.Clamp(v, 0, 1) : 0;
}

/// <summary>Physical state of one car — everything <see cref="PoCabinetPhysics.Step"/> reads or writes.</summary>
public class PoCabinetCarBody
{
    public double X { get; set; }
    public double Y { get; set; }
    /// <summary>Radians; forward is (cos h, sin h). Right-hand side is (-sin h, cos h).</summary>
    public double Heading { get; set; }
    /// <summary>Units per second along the heading; negative while reversing.</summary>
    public double Speed { get; set; }
    public int SegHint { get; set; } = -1;
    /// <summary>Arc-length position on the loop, in [0, Length).</summary>
    public double Along { get; set; }
    /// <summary>Unwrapped race distance: starts negative on the grid, one lap = track length.</summary>
    public double Distance { get; set; }
    public double Lateral { get; set; }
    public bool Sliding { get; set; }
    /// <summary>Sideways speed a contact left behind, units/s (+ = to the car's right). The tyres scrub it off.</summary>
    public double Slip { get; set; }
    /// <summary>Yaw rate a contact left behind, rad/s. Bleeds off the same way.</summary>
    public double Spin { get; set; }
    /// <summary>Structure the hits have cost, 0..1 (see <see cref="PoCabinetPhysics.Hurt"/>): grip.</summary>
    public double Damage { get; set; }
    /// <summary>Engine the hits have cost, 0..1: power and top speed.</summary>
    public double Engine { get; set; }
    /// <summary>Misalignment, -1..1 (+ pulls right): a steady pull on the wheel and lost lock.</summary>
    public double Pull { get; set; }
    /// <summary>Structure or engine gone: the engine is dead but for a limp off the road.</summary>
    public bool Wrecked { get; set; }
    /// <summary>What it is on (<see cref="PoCabinetPhysics.SurfRoad"/> …), set at the end of each step for the next.</summary>
    public int Surface { get; set; }
    /// <summary>All four wheels past the track limits on the last step.</summary>
    public bool Wide { get; set; }
}

/// <summary>Race conditions for <see cref="PoCabinetPhysics.Step"/>: rain, and how much rubber is
/// down (<see cref="PoCabinetTrack.RubberAt"/>). Default: dry, green track.</summary>
public readonly record struct PoCabinetConditions(bool Wet, double Rubber);

/// <summary>
/// Arcade car physics shared by every PoCabinet race: a speed-along-heading model with a
/// lateral-grip cap (understeer past it), grass run-off with extra drag, and a barrier that
/// removes the outward velocity component.
///
/// <para>
/// Contacts are between car-shaped hulls, not circles: a capsule 39 long and 17
/// wide, the body the client draws. A hit is an impulse along the contact normal (equal masses,
/// a little restitution) applied where the hulls touch, so it shoves a car sideways
/// (<see cref="PoCabinetCarBody.Slip"/>) and turns it (<see cref="PoCabinetCarBody.Spin"/>) as
/// well as changing its speed; <see cref="Step"/> then bleeds both off through the tyres.
/// </para>
/// <para>
/// Damage is sim state (<see cref="Hurt"/>): every barrier hit and contact harder than a nudge
/// costs structure, engine and alignment by how hard it closed and where on the body it landed.
/// A bent car pulls and has less lock, power, top speed and grip; a wrecked one has a dead
/// engine but for a limp off the racing line, then stops.
/// </para>
/// <para>
/// Hills and banking are physics too: gravity along the road's grade speeds a car downhill and
/// slows it uphill (with drag past top speed, so a descent tops out), a banked turn holds it in,
/// and braking takes grip from cornering (a friction circle).
/// </para>
/// <para>
/// <b>Mirror contract:</b> <c>wwwroot/js/pocabinet/physics.js</c> ports <see cref="Step"/>,
/// <see cref="Hurt"/>, <see cref="ResolveContacts"/>, <see cref="GridBack"/> and <see cref="GridSlot"/> line for
/// line, with the same constants. Solo races run the JS copy; multiplayer runs this one on the server while the
/// browser runs the JS copy to predict its own car and replays unacknowledged inputs on top of
/// each snapshot. If the two diverge, every correction becomes a visible snap.
/// </para>
/// </summary>
public static class PoCabinetPhysics
{
    public const double TickSeconds = 1.0 / 30.0;
    /// <summary>Top speed on tarmac at full throttle, units/s.</summary>
    public const double MaxSpeed = 140;
    /// <summary>HUD conversion: 140 units/s reads as 280 km/h.</summary>
    public const double KmhPerUnit = 2.0;
    public const double Accel = 55;
    public const double BrakeDecel = 130;
    public const double CoastDecel = 14;
    public const double ReverseAccel = 25;
    public const double ReverseMax = 18;
    /// <summary>Yaw rate at full lock once rolling, rad/s.</summary>
    public const double SteerRate = 2.3;
    /// <summary>Below this speed the available lock scales down linearly — no pivoting on the spot.</summary>
    public const double SteerFullSpeed = 18;
    /// <summary>Lateral acceleration cap (speed × yaw rate). Asking for more understeers.</summary>
    public const double GripAccel = 105;
    public const double ScrubDecel = 30;
    public const double GrassDecel = 50;
    public const double GrassGrip = 0.6;
    /// <summary>Grass strip between the road edge and the barrier.</summary>
    public const double RunOff = 26;
    public const double CarRadius = 14;
    public const double WallRestitution = 0.25;
    public const double WallFriction = 0.85;
    /// <summary>Most negative speed a contact may leave a car with.</summary>
    public const double ContactSpeedFloor = ReverseMax * 1.5;
    /// <summary>Hull: a spine of ±<see cref="HullHalf"/> along the heading, <see cref="HullRadius"/> thick (39 x 17 overall).</summary>
    public const double HullHalf = 11;
    public const double HullRadius = 8.5;
    public const double ContactRestitution = 0.2;
    /// <summary>Yaw inertia over mass: the square of a 39 x 17 body's radius of gyration.</summary>
    public const double YawInertia = 150;
    public const double SlipDecel = 120;
    public const double SpinDecel = 5;
    public const double MaxSlip = 60;
    public const double MaxSpin = 2.5;
    public const double SlipSliding = 8;
    /// <summary>Cars further apart than this along the road never touch: where the Playground run
    /// crosses over itself they are on different levels.</summary>
    public const double SameRoad = 120;
    public const double GridColumn = 22;
    public const double GridRow = 50;
    /// <summary>Damage: closing speed a body shrugs off, and the square of the excess over it that
    /// takes all of a car's structure (a square hit on the barrier at about 110 u/s).</summary>
    public const double DamageFloor = 12;
    public const double DamageScale = 9500;
    /// <summary>Engine share of a hit on the nose and of one anywhere else.</summary>
    public const double EngineNose = 1.25;
    public const double EngineOther = 0.3;
    /// <summary>Misalignment from a hit on a front corner and from one further back.</summary>
    public const double PullNose = 2.2;
    public const double PullOther = 0.6;
    /// <summary>What full damage costs: power and top speed (engine), grip (structure), lock and pull (alignment).</summary>
    public const double PowerLoss = 0.5;
    public const double TopLoss = 0.2;
    public const double GripLoss = 0.2;
    public const double LockLoss = 0.3;
    public const double PullSteer = 0.14;
    /// <summary>A wrecked car limps at no more than this, and only until it is this far off the tarmac.</summary>
    public const double LimpSpeed = 14;
    public const double LimpThrottle = 0.5;
    public const double WreckClear = 16;
    /// <summary>Hills: gravity along the road (u/s² per unit of grade) and the drag on speed past
    /// a car's top speed, so a long descent tops out.</summary>
    public const double SlopeGravity = 60;
    public const double OverspeedDrag = 1.2;
    /// <summary>Grip a turn banked into it adds per unit of bank (off-camber takes up to half that).</summary>
    public const double BankGrip = 0.6;
    /// <summary>The friction circle: the share of cornering grip full brake pressure takes.</summary>
    public const double TrailLoss = 0.25;
    /// <summary>What a car is on (<see cref="PoCabinetCarBody.Surface"/>): the road, an apex kerb
    /// (flat or raised), or the run-off. Gravel beaches a car fast; tarmac run-off costs nothing
    /// but the lap; a raised kerb scrubs speed and throws the car out. Gravel and tarmac run-off
    /// are deeper than grass: the barrier stands <see cref="RunOffWide"/> out there.</summary>
    public const int SurfRoad = 0, SurfKerb = 1, SurfSausage = 2, SurfGrass = 3, SurfGravel = 4, SurfRunoff = 5;
    public const double RunOffWide = 40;
    /// <summary>How far an apex kerb reaches onto the tarmac, and out past the edge line.</summary>
    public const double KerbInner = 5;
    public const double KerbOuter = 12;
    public const double KerbGrip = 0.97;
    public const double KerbWetGrip = 0.8;
    public const double SausageGrip = 0.85;
    public const double SausageScrub = 45;
    public const double SausageKick = 1.1;
    public const double GravelGrip = 0.45;
    public const double GravelDecel = 95;

    /// <summary>Barrier distance from the centerline on the track's nominal width.</summary>
    public static double WallLateral(PoCabinetTrack track) => track.HalfWidth + RunOff - CarRadius * 0.5;

    /// <summary>How deep the run-off is at sample <paramref name="i"/> on <paramref name="side"/>. Mirrors physics.js <c>runOffAt</c>.</summary>
    public static double RunOffAt(PoCabinetTrack track, int i, int side) => track.RunoffAt(i, side) == 0 ? RunOff : RunOffWide;

    /// <summary>Where a car's centre meets the barrier at sample <paramref name="i"/> on <paramref name="side"/>. Mirrors physics.js <c>wallAt</c>.</summary>
    public static double WallAt(PoCabinetTrack track, int i, int side) => track.HalfWidthAt(i) + RunOffAt(track, i, side) - CarRadius * 0.5;

    /// <summary>What a car <paramref name="lateral"/> off the centerline at sample <paramref name="i"/> is on. Mirrors physics.js <c>surfaceAt</c>.</summary>
    public static int SurfaceAt(PoCabinetTrack track, int i, double lateral)
    {
        double hw = track.HalfWidthAt(i);
        double l = Math.Abs(lateral);
        int s = lateral > 0 ? 1 : -1;
        int k = track.KerbAt(i);
        if (k != 0 && (k > 0 ? 1 : -1) == s && l > hw - KerbInner && l < hw + KerbOuter)
        {
            return k == 2 || k == -2 ? SurfSausage : SurfKerb;
        }
        if (l <= hw) return SurfRoad;
        int kind = track.RunoffAt(i, s);
        return kind == 1 ? SurfGravel : kind == 2 ? SurfRunoff : SurfGrass;
    }

    /// <summary>Track limits: all four wheels past the edge (the kerb counts as track). Mirrors physics.js <c>beyondLimits</c>.</summary>
    public static bool Beyond(PoCabinetTrack track, int i, double lateral)
    {
        int s = lateral > 0 ? 1 : -1;
        int k = track.KerbAt(i);
        double edge = track.HalfWidthAt(i) + (k != 0 && (k > 0 ? 1 : -1) == s ? KerbOuter : 0);
        return Math.Abs(lateral) - HullRadius > edge;
    }

    /// <summary>Where the car ends up this step and how it is moving (<see cref="Bounce"/>'s state).</summary>
    private struct StepState
    {
        public double X, Y, Heading, V2, Slip;
    }

    /// <summary>
    /// The car has gone <paramref name="excess"/> into a barrier on side <paramref name="s"/> of it
    /// at <paramref name="proj"/>: put it back on the face and, if it was closing, damage it and
    /// take the closing speed off. Shared by the edge barriers and the dividers. Mirrors physics.js <c>bounce</c>.
    /// </summary>
    private static void Bounce(PoCabinetCarBody car, PoCabinetTrackProjection proj, double s, double excess, ref StepState st)
    {
        double nx = -proj.Ty * s, ny = proj.Tx * s;
        st.X -= nx * excess;
        st.Y -= ny * excess;
        double ch = PoCabinetDetMath.Cos(st.Heading), sh = PoCabinetDetMath.Sin(st.Heading);
        double vx = ch * st.V2 - sh * st.Slip, vy = sh * st.V2 + ch * st.Slip;
        double vn = vx * nx + vy * ny;
        if (vn > 0)
        {
            // The part of the body facing the barrier takes it, pushed straight back from it.
            double fn = nx * ch + ny * sh, sn = ny * ch - nx * sh;
            Hurt(car, vn, fn * (HullHalf + HullRadius), sn * HullRadius);
            double tx = vx - nx * vn, ty = vy - ny * vn;
            vx = tx * WallFriction - nx * vn * WallRestitution;
            vy = ty * WallFriction - ny * vn * WallRestitution;
            double speed = Math.Sqrt(vx * vx + vy * vy);
            if (speed > 1) st.Heading = st.V2 >= 0 ? PoCabinetDetMath.Atan2(vy, vx) : PoCabinetDetMath.Atan2(-vy, -vx);
            st.V2 = st.V2 >= 0 ? speed : -speed;
            st.Slip = 0; // the car leaves the barrier pointing the way it is going
        }
    }

    /// <summary>
    /// Advance one car by <paramref name="dt"/>. <paramref name="grip"/> is the weather factor
    /// (1 = dry). Contacts with other cars are a separate pass (<see cref="ResolveContacts"/>).
    /// </summary>
    public static void Step(PoCabinetTrack track, PoCabinetCarBody car, PoCabinetControls c, double dt, double grip, PoCabinetConditions cond = default)
    {
        double throttle = c.Throttle, brake = c.Brake, steer = c.Steer;
        double v = car.Speed;
        // The road under it (last tick's segment and surface): what it is on, and the grip the
        // patches, the rubber and the kerbs there give.
        int seg = car.SegHint;
        int surf = car.Surface;
        double surfaceGrip = surf == SurfGrass ? GrassGrip : surf == SurfGravel ? GravelGrip
            : surf == SurfKerb ? (cond.Wet ? KerbWetGrip : KerbGrip) : surf == SurfSausage ? SausageGrip : 1;
        if (seg >= 0) surfaceGrip *= track.GripAt(seg, car.Lateral, cond.Wet, cond.Rubber);
        // What the hits have cost: a wrecked engine gives only a limp, and only until the car is
        // clear of the tarmac; a bent car pulls and has lost lock, power, top speed and grip.
        if (car.Wrecked)
        {
            throttle = Math.Abs(car.Lateral) > (seg >= 0 ? track.HalfWidthAt(seg) : track.HalfWidth) + WreckClear || v >= LimpSpeed ? 0 : Math.Min(throttle, LimpThrottle);
        }
        steer = Math.Min(1, Math.Max(-1, steer * (1 - LockLoss * Math.Abs(car.Pull)) + PullSteer * car.Pull));
        double power = 1 - PowerLoss * car.Engine;
        double top = MaxSpeed * (1 - TopLoss * car.Engine);
        grip = grip * (1 - GripLoss * car.Damage);
        // How steep the way it is pointing, how banked.
        double roadDot = seg >= 0 ? PoCabinetDetMath.Cos(car.Heading) * track.TangentX(seg) + PoCabinetDetMath.Sin(car.Heading) * track.TangentY(seg) : 0;
        double slope = seg >= 0 ? track.Grade(seg) * roadDot : 0;
        double bank = seg >= 0 ? track.Bank(seg) : 0;

        // ── Longitudinal ────────────────────────────────────────────────
        double v2;
        if (v < -0.01)
        {
            // Rolling backwards: brake keeps reversing, throttle (or nothing) pulls back to zero.
            if (brake > 0 && throttle == 0)
            {
                v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
            }
            else
            {
                v2 = v + (throttle * Accel + CoastDecel) * dt;
                if (throttle == 0) v2 = Math.Min(v2, 0);
            }
        }
        else if (v <= 0.5 && throttle == 0 && brake > 0)
        {
            // Stopped with the brake held: that is the reverse gear.
            v2 = Math.Max(-ReverseMax, v - ReverseAccel * brake * dt);
        }
        else
        {
            double ratio = v / top;
            double a = throttle * Accel * power * grip * Math.Max(0, 1 - ratio * ratio)
                       - brake * BrakeDecel
                       - CoastDecel * (1 - throttle);
            // Grass drags, gravel beaches the car, a raised kerb scrubs it.
            if (surf == SurfGrass && v > 25) a -= GrassDecel;
            else if (surf == SurfGravel && v > 8) a -= GravelDecel;
            else if (surf == SurfSausage && v > 15) a -= SausageScrub;
            // Downhill pulls the car on and uphill holds it back; past its top speed the air
            // takes the excess back.
            a -= SlopeGravity * slope;
            if (v > top) a -= OverspeedDrag * (v - top);
            v2 = Math.Max(0, v + a * dt);
        }

        // ── Steering with a lateral-grip cap ────────────────────────────
        double speedAbs = Math.Abs(v2);
        double lockScale = Math.Min(1, speedAbs / SteerFullSpeed);
        double omegaWanted = steer * SteerRate * lockScale * (v2 < 0 ? -1 : 1);
        // Grip to turn with: more in a turn banked into it, less off-camber, and less again for
        // what the brakes are using (the friction circle).
        double camber = omegaWanted > 0 ? -bank : bank;
        double omegaGrip = GripAccel * grip * surfaceGrip * (1 + BankGrip * Math.Min(1, Math.Max(-0.5, camber)))
            * (1 - TrailLoss * brake * brake) / Math.Max(speedAbs, 1);
        double omega = Math.Clamp(omegaWanted, -omegaGrip, omegaGrip);
        car.Sliding = Math.Abs(omegaWanted) > omegaGrip * 1.02 && speedAbs > 30;
        if (car.Sliding)
        {
            v2 = v2 > 0 ? Math.Max(0, v2 - ScrubDecel * dt) : Math.Min(0, v2 + ScrubDecel * dt);
        }

        // What a contact left behind: the tyres scrub the sideways slide and the spin off.
        double slipGrip = SlipDecel * grip * surfaceGrip * dt;
        double slip = car.Slip > 0 ? Math.Max(0, car.Slip - slipGrip) : Math.Min(0, car.Slip + slipGrip);
        double spin = car.Spin > 0 ? Math.Max(0, car.Spin - SpinDecel * dt) : Math.Min(0, car.Spin + SpinDecel * dt);
        // A raised kerb throws the car out, away from the apex, by how fast it takes it.
        if (surf == SurfSausage && speedAbs > 15) slip += (car.Lateral > 0 ? 1 : -1) * roadDot * SausageKick * speedAbs * dt;
        if (Math.Abs(slip) > SlipSliding) car.Sliding = true;

        double heading = car.Heading + (omega + spin) * dt;
        double ch = PoCabinetDetMath.Cos(heading), sh = PoCabinetDetMath.Sin(heading);
        var st = new StepState
        {
            X = car.X + (ch * v2 - sh * slip) * dt,
            Y = car.Y + (sh * v2 + ch * slip) * dt,
            Heading = heading,
            V2 = v2,
            Slip = slip,
        };

        // ── Track: the barriers at the edge of the run-off (deeper where it is gravel or
        // tarmac), and a road divider, faced from whichever side the car is on ──
        var proj = track.Project(st.X, st.Y, car.SegHint);
        int side = proj.Lateral > 0 ? 1 : -1;
        double wallLat = WallAt(track, proj.Index, side);
        if (Math.Abs(proj.Lateral) > wallLat)
        {
            Bounce(car, proj, side, Math.Abs(proj.Lateral) - wallLat, ref st);
            proj = track.Project(st.X, st.Y, proj.Index);
        }
        if (track.IslandIndexAt(proj.Index) >= 0)
        {
            double lo = track.IslandLo(proj.Index) - CarRadius * 0.5, hi = track.IslandHi(proj.Index) + CarRadius * 0.5;
            if (proj.Lateral > lo && proj.Lateral < hi)
            {
                double toLo = proj.Lateral - lo, toHi = hi - proj.Lateral;
                if (toLo < toHi) Bounce(car, proj, 1, toLo, ref st);
                else Bounce(car, proj, -1, toHi, ref st);
                proj = track.Project(st.X, st.Y, proj.Index);
            }
        }

        car.X = st.X;
        car.Y = st.Y;
        car.Heading = PoCabinetDetMath.WrapAngle(st.Heading);
        car.Speed = st.V2;
        car.Slip = st.Slip;
        car.Spin = spin;
        car.SegHint = proj.Index;
        car.Lateral = proj.Lateral;
        car.Surface = SurfaceAt(track, proj.Index, proj.Lateral);
        car.Wide = Beyond(track, proj.Index, proj.Lateral);
        AdvanceDistance(track, car, proj.Along);
    }

    /// <summary>Unwrap the loop position into race distance (so reversing over the line un-counts it).</summary>
    private static void AdvanceDistance(PoCabinetTrack track, PoCabinetCarBody car, double along)
    {
        double delta = along - car.Along;
        double half = track.Length * 0.5;
        if (delta > half) delta -= track.Length;
        else if (delta < -half) delta += track.Length;
        car.Distance += delta;
        car.Along = along;
    }

    /// <summary>
    /// Where two hulls touch: false when they are apart, else the unit normal (a → b), the
    /// overlap depth and the contact point. Mirrors physics.js <c>hullContact</c> (slack 0).
    /// </summary>
    private static bool HullContact(PoCabinetCarBody a, PoCabinetCarBody b,
        out double nx, out double ny, out double depth, out double cx, out double cy)
    {
        nx = ny = depth = cx = cy = 0;
        double reach = (HullHalf + HullRadius) * 2;
        double dx = b.X - a.X, dy = b.Y - a.Y;
        if (dx > reach || dx < -reach || dy > reach || dy < -reach) return false;
        double ahx = PoCabinetDetMath.Cos(a.Heading), ahy = PoCabinetDetMath.Sin(a.Heading);
        double bhx = PoCabinetDetMath.Cos(b.Heading), bhy = PoCabinetDetMath.Sin(b.Heading);
        // Closest points of the two spines: a + s·ha and b + t·hb, s and t in ±HullHalf.
        double dot = ahx * bhx + ahy * bhy;
        double da = -(ahx * dx + ahy * dy), db = -(bhx * dx + bhy * dy);
        double denom = 1 - dot * dot;
        // Within ~10° of parallel the sides meet along their overlap, not at one end: take its
        // middle, or every side-by-side rub would turn both cars.
        double s = denom > 0.03 ? (dot * db - da) / denom : -da * 0.5;
        s = Math.Min(HullHalf, Math.Max(-HullHalf, s));
        double t = dot * s + db;
        if (t < -HullHalf)
        {
            t = -HullHalf;
            s = Math.Min(HullHalf, Math.Max(-HullHalf, t * dot - da));
        }
        else if (t > HullHalf)
        {
            t = HullHalf;
            s = Math.Min(HullHalf, Math.Max(-HullHalf, t * dot - da));
        }
        double px = a.X + ahx * s, py = a.Y + ahy * s;
        double qx = b.X + bhx * t, qy = b.Y + bhy * t;
        double ex = qx - px, ey = qy - py;
        double d = Math.Sqrt(ex * ex + ey * ey);
        if (d <= 1e-6 || d >= HullRadius * 2) return false;
        nx = ex / d;
        ny = ey / d;
        depth = HullRadius * 2 - d;
        cx = (px + qx) * 0.5;
        cy = (py + qy) * 0.5;
        return true;
    }

    /// <summary>
    /// Pairwise hull contacts in index order: separate the two cars, then one impulse along the
    /// normal at the contact point, shared between each car's speed, sideways slip and spin.
    /// Order-dependent by design (index order), identically in JS.
    /// </summary>
    // ponytail: O(n²) pair scan, 4,950 pairs a tick at 100 cars (the lap verifier pays it per
    // replayed tick). Sort by Along and sweep if a field ever gets bigger than that. An array,
    // not IReadOnlyList: through the interface the scan cost twelve seconds a replay.
    public static void ResolveContacts(PoCabinetTrack track, PoCabinetCarBody[] cars)
    {
        double half = track.Length * 0.5;
        for (int i = 0; i < cars.Length; i++)
        {
            var a = cars[i];
            if (track.Parked(a.Distance)) continue;
            for (int j = i + 1; j < cars.Length; j++)
            {
                var b = cars[j];
                double gap = b.Along - a.Along;
                if (gap > half) gap -= track.Length;
                else if (gap < -half) gap += track.Length;
                if (gap > SameRoad || gap < -SameRoad || track.Parked(b.Distance)) continue;
                if (!HullContact(a, b, out double nx, out double ny, out double depth, out double cx, out double cy)) continue;
                double rax = cx - a.X, ray = cy - a.Y;
                double rbx = cx - b.X, rby = cy - b.Y;
                double push = depth * 0.5;
                a.X -= nx * push;
                a.Y -= ny * push;
                b.X += nx * push;
                b.Y += ny * push;

                double ahx = PoCabinetDetMath.Cos(a.Heading), ahy = PoCabinetDetMath.Sin(a.Heading);
                double bhx = PoCabinetDetMath.Cos(b.Heading), bhy = PoCabinetDetMath.Sin(b.Heading);
                // Each hull's velocity at the contact point: forward speed, slip to its right, spin.
                double vax = ahx * a.Speed - ahy * a.Slip - a.Spin * ray, vay = ahy * a.Speed + ahx * a.Slip + a.Spin * rax;
                double vbx = bhx * b.Speed - bhy * b.Slip - b.Spin * rby, vby = bhy * b.Speed + bhx * b.Slip + b.Spin * rbx;
                double closing = (vax - vbx) * nx + (vay - vby) * ny;
                if (closing <= 0) continue;
                double armA = rax * ny - ray * nx, armB = rbx * ny - rby * nx;
                double impulse = (1 + ContactRestitution) * closing / (2 + (armA * armA + armB * armB) / YawInertia);
                a.Speed -= impulse * (nx * ahx + ny * ahy);
                a.Slip -= impulse * (ny * ahx - nx * ahy);
                a.Spin -= impulse * armA / YawInertia;
                b.Speed += impulse * (nx * bhx + ny * bhy);
                b.Slip += impulse * (ny * bhx - nx * bhy);
                b.Spin += impulse * armB / YawInertia;
                // Bounded so a shove can't launch a car past what its own engine could do:
                // unbounded, a car rammed while facing backwards reached -49 u/s and the two
                // cars locked together for the rest of the race.
                a.Speed = Math.Min(MaxSpeed * 1.08, Math.Max(-ContactSpeedFloor, a.Speed));
                b.Speed = Math.Min(MaxSpeed * 1.08, Math.Max(-ContactSpeedFloor, b.Speed));
                a.Slip = Math.Min(MaxSlip, Math.Max(-MaxSlip, a.Slip));
                b.Slip = Math.Min(MaxSlip, Math.Max(-MaxSlip, b.Slip));
                a.Spin = Math.Min(MaxSpin, Math.Max(-MaxSpin, a.Spin));
                b.Spin = Math.Min(MaxSpin, Math.Max(-MaxSpin, b.Spin));
                // Both bodies take the hit where they touched.
                Hurt(a, closing, rax * ahx + ray * ahy, ray * ahx - rax * ahy);
                Hurt(b, closing, rbx * bhx + rby * bhy, rby * bhx - rbx * bhy);
            }
        }
    }

    /// <summary>
    /// A hit on <paramref name="car"/> closing at <paramref name="closing"/> u/s, landing
    /// (<paramref name="fwd"/>, <paramref name="side"/>) from its centre in its own frame (+ =
    /// ahead, + = right). What it costs goes as the square of the closing speed over
    /// <see cref="DamageFloor"/>: structure wherever it lands, the engine mostly from the nose,
    /// and the alignment from a corner (the car pulls toward it). Mirrors physics.js <c>hurt</c>
    /// (which also reports the hit to the renderer for the dents).
    /// </summary>
    public static void Hurt(PoCabinetCarBody car, double closing, double fwd, double side)
    {
        double e = closing - DamageFloor;
        if (!(e > 0) || car.Wrecked) return;
        double s = e * e / DamageScale;
        bool nose = fwd > HullHalf;
        double across = Math.Min(1, Math.Max(-1, side / HullRadius));
        car.Damage = Math.Min(1, car.Damage + s);
        car.Engine = Math.Min(1, car.Engine + s * (nose ? EngineNose : EngineOther));
        car.Pull = Math.Min(1, Math.Max(-1, car.Pull + across * s * (nose ? PullNose : PullOther)));
        if (car.Damage >= 1 || car.Engine >= 1) car.Wrecked = true;
    }

    /// <summary>Columns of the starting grid: as many as the tarmac takes, at least two.</summary>
    public static int GridColumns(PoCabinetTrack track) =>
        Math.Max(2, (int)Math.Floor(track.HalfWidth * 1.6 / GridColumn) + 1);

    /// <summary>
    /// Distance behind the line of grid row <paramref name="row"/>. Rows are
    /// <see cref="GridRow"/> apart, but none stands on a bend tighter than one and a half road
    /// widths: there the slots of neighbouring rows fan into each other, so the row moves back
    /// to where the road has straightened.
    /// </summary>
    public static double GridBack(PoCabinetTrack track, int row)
    {
        double limit = 1 / (track.HalfWidth * 1.5);
        double back = 18;
        for (int r = 0; back < track.Length;)
        {
            double at = track.Length - back;
            if (track.MaxCurvature(at - 25, at + 25) > limit)
            {
                back += 8;
                continue;
            }
            if (r == row) break;
            r++;
            back += GridRow;
        }
        return back;
    }

    /// <summary>
    /// Starting-grid slot <paramref name="slot"/>: rows across the tarmac, pole just behind the
    /// line, so every car's race distance starts negative and lap 1 ends at one lap length.
    /// </summary>
    public static void GridSlot(PoCabinetTrack track, PoCabinetCarBody car, int slot)
    {
        int cols = GridColumns(track);
        double back = GridBack(track, slot / cols);
        double lateral = (slot % cols - (cols - 1) / 2.0) * GridColumn;
        var p = track.PointAt(track.Length - back);
        car.X = p.X + -p.Ty * lateral;
        car.Y = p.Y + p.Tx * lateral;
        car.Heading = PoCabinetDetMath.Atan2(p.Ty, p.Tx);
        car.Speed = 0;
        car.Slip = 0;
        car.Spin = 0;
        // Hinted with where the slot is: a long grid runs back over other parts of a course
        // that crosses itself, and a blind nearest-point search can land on the wrong level.
        var proj = track.Project(car.X, car.Y, track.IndexAt(track.Length - back));
        car.SegHint = proj.Index;
        car.Along = proj.Along;
        car.Lateral = proj.Lateral;
        car.Surface = SurfRoad;
        car.Wide = false;
        // Race distance starts negative: the slot's own distance behind the line, corrected by
        // where the car projects (a bend moves an outer slot a little along the road). Not
        // "along minus a lap": a front-row slot on a tight last bend can project past the line.
        double off = proj.Along - (track.Length - back);
        if (off > track.Length * 0.5) off -= track.Length;
        else if (off < -track.Length * 0.5) off += track.Length;
        car.Distance = off - back;
    }
}
