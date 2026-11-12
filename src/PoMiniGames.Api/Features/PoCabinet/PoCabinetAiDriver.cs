using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// Picks controls for an AI official each tick: aim at a point ahead on the road,
/// offset to the lane it wants, and hold a speed the next corner and the car ahead allow.
/// The AI drives through the same <see cref="PoCabinetPhysics.Step"/> as a player — it gets
/// throttle/brake/steer, never a position — so it obeys grip, grass and barriers.
///
/// <para>
/// It drives the track's racing line (wide on the way in, the apex, wide on the way out), brakes
/// where the braking curve it plans on meets the next corner, plans that corner on the grip its
/// damage has left it, and moves over for a leader coming to lap it.
/// </para>
/// <para>
/// Personality shapes the driving, not the physics: <c>LateralOffset</c> is how far off the
/// racing line it holds,
/// <c>LookaheadDistance</c> how early it turns in, <c>BrakingAggression</c> how late and how
/// hard it brakes for a corner, <c>CollisionTolerance</c> how much it insists on its own line
/// in traffic, <c>DraftingAffinity</c> how keenly it tucks in behind a car,
/// <c>Wildness</c> how often it overcooks a corner and runs off the road (<see cref="Lapse"/>),
/// <c>Aggression</c> how it treats the car ahead and alongside (a bruiser follows close
/// enough to bump and turns in on a car beside it) and <c>Twitch</c> how hard it saws at the
/// wheel. A wrecked car is driven off the racing line instead (<see cref="Wrecked"/>).
/// </para>
/// <para>
/// Traffic (built for the 100-car solo field) is three rules: follow the car in
/// its path no faster than it can still brake down to that car's speed; take the lane with the
/// longest clear run ahead; never turn in on a car alongside. Watching only the nearest car
/// ahead by race distance is something five cars survive and a hundred do not.
/// </para>
/// <para>
/// Deterministic; the only state is per-thread scratch. <c>wwwroot/js/pocabinet/physics.js</c>
/// (<c>aiControls</c>) is the browser port the solo race and the demo autopilot use.
/// </para>
/// </summary>
public static class PoCabinetAiDriver
{
    /// <summary>Gap it keeps to the car ahead (centres; hulls touch at 39) and the braking it plans on.</summary>
    private const double FollowGap = 44;
    private const double FollowDecel = 80;
    /// <summary>How far up the road it looks for traffic.</summary>
    private const double Range = 170;
    /// <summary>A driver's lapses are drawn once per stretch of road this long, and last this far into it.</summary>
    private const double LapseStretch = 380;
    private const double LapseLength = 170;
    /// <summary>How far over its own pace a car lets a descent carry it before it brakes for it.</summary>
    private const double RunOn = 30;
    /// <summary>How far ahead it starts picking its side of a road divider, and how wide it keeps of it.</summary>
    private const double IslandLook = 320;
    private const double IslandClear = 14;
    /// <summary>Braking points: the deceleration a driver plans on, from a cautious one's to (+ the
    /// late share) a late braker's. Well under <see cref="PoCabinetPhysics.BrakeDecel"/>.</summary>
    private const double BrakePlan = 60;
    private const double BrakePlanLate = 40;
    /// <summary>How much of the track's racing line a driver follows, and how far (a share of the half
    /// width) its own <c>LateralOffset</c> sets it off that line, so a hundred cars are not all on one
    /// line (the whole line packed the field onto the apexes and into each other).</summary>
    private const double LineWeight = 0.6;
    private const double LineBias = 0.5;
    /// <summary>The share of its pace a bent car gives up at full structural damage (on top of
    /// planning its corners on the grip it has left).</summary>
    private const double DamagePace = 0.05;
    /// <summary>Blue flags: how far behind it watches for a car coming to lap it, how close to its
    /// own lane that car must be, how much quicker along the road, how far over it eases each tick
    /// (a share of the half width) and how much it lifts to let the leader by.</summary>
    private const double BlueLook = 80;
    private const double BlueLane = 30;
    private const double BlueClosing = 3;
    private const double BlueStep = 0.1;
    private const double BlueLift = 0.95;
    /// <summary>Aim error (radians) past which a car rolling forward is pointing the wrong way down the road.</summary>
    private const double WrongWay = 2;

    // Scratch for one Decide call: the cars ahead that are in the way, and how far ahead each is.
    [ThreadStatic] private static PoCabinetCarBody[]? _near;
    [ThreadStatic] private static double[]? _nearGap;

    public static PoCabinetControls Decide(
        PoCabinetTrack track,
        PoCabinetCarBody car,
        PoCabinetPersonality personality,
        double maxSpeed,
        double corneringSkill,
        PoCabinetCarBody[] field,
        double grip)
    {
        if (car.Wrecked) return Wrecked(track, car);
        double v = car.Speed;
        int seg = car.SegHint >= 0 ? car.SegHint : track.IndexAt(car.Along);
        double hw = track.HalfWidthAt(seg);
        double edge = hw * 0.8;
        // Steering aims at a point ahead, further ahead at speed; the line there is the track's
        // racing line (wide on the way in, the apex, wide on the way out), set off it by the
        // driver's own bias.
        double look = personality.LookaheadDistance * 0.5 + 20 + Math.Abs(v) * 0.45;
        double racing = track.LineAt(track.IndexAt(car.Along + look)) * LineWeight;
        double line = Math.Min(edge, Math.Max(-edge, racing + personality.LateralOffset * hw * LineBias));
        double lateralTarget = line;

        // Traffic. What is in the way (the car to follow, a car alongside) is judged in this
        // car's own frame, from where the two actually are: the centerline has kinks tighter
        // than a car, and across one of those "ahead on the road" is noise that parked a whole
        // field behind a car that was beside it. Lanes are a road notion, so the lane choice
        // reads road positions: the nearest car ahead, and the ones not pulling away.
        var near = _near;
        var nearGap = _nearGap;
        if (near is null || nearGap is null || near.Length < field.Length)
        {
            _near = near = new PoCabinetCarBody[Math.Max(16, field.Length)];
            _nearGap = nearGap = new double[near.Length];
        }
        double half = track.Length * 0.5;
        double hx = PoCabinetDetMath.Cos(car.Heading), hy = PoCabinetDetMath.Sin(car.Heading);
        double own = (hx * v - hy * car.Slip) * track.TangentX(seg) + (hy * v + hx * car.Slip) * track.TangentY(seg);
        PoCabinetCarBody? ahead = null, blocker = null, blue = null;
        double gap = double.MaxValue, blockGap = double.MaxValue, blueGap = -BlueLook;
        bool left = false, right = false;
        int count = 0;
        for (int i = 0; i < field.Length; i++)
        {
            var other = field[i];
            if (ReferenceEquals(other, car)) continue;
            // Along the road first: it wraps the lap (a lapped or cooling-down car counts) and
            // drops the other level of a crossing.
            double d = other.Along - car.Along;
            if (d > half) d -= track.Length;
            else if (d < -half) d += track.Length;
            if (d <= -Range || d >= Range || track.Parked(other.Distance)) continue;
            // A car the other side of a road divider is in another lane altogether: on a bend it
            // can look dead ahead, and two lanes braking for each other stop both.
            if (SplitBy(track, car, other)) continue;
            double dx = other.X - car.X, dy = other.Y - car.Y;
            double fwd = dx * hx + dy * hy, side = dy * hx - dx * hy;
            if (fwd > -44 && fwd < 44)
            {
                if (side > 12 && side < 30) right = true;
                else if (side < -12 && side > -30) left = true;
            }
            // Blue flag: the nearest car close behind on the road, near its lane, that is really a
            // lap or more ahead and coming up on it.
            if (d < 0 && d > blueGap && !other.Wrecked && other.Distance - car.Distance > half
                && Math.Abs(other.Lateral - car.Lateral) < BlueLane && RoadSpeed(track, other) > own + BlueClosing)
            {
                blueGap = d;
                blue = other;
            }
            // In its path AND ahead of it on the road: two cars converging at an angle are each
            // in the other's path, and without the second test both wait for the other forever.
            // A wreck is never followed: it is not going anywhere, so it is a lane to avoid (below).
            if (d > 0 && fwd > 4 && fwd < blockGap && Math.Abs(side) < 20 && !other.Wrecked)
            {
                blockGap = fwd;
                blocker = other;
            }
            if (d <= 4) continue;
            if (d < gap && !other.Wrecked)
            {
                gap = d;
                ahead = other;
            }
            // Not pulling away: slower, or quick but going nowhere along the road (spun, sideways).
            if (other.Speed < v + 4 || RoadSpeed(track, other) < other.Speed * 0.5)
            {
                near[count] = other;
                nearGap[count] = d;
                count++;
            }
        }
        if (ahead is not null && personality.DraftingAffinity > 0.5 && gap > 50)
        {
            lateralTarget = ahead.Lateral; // tuck in behind it
        }
        else if (count > 0)
        {
            // Pick a lane: its own line and seven across the tarmac, scored by the clear road
            // ahead, less how far the lane is from its line (a tolerant driver insists on its
            // line) and from where the car is now (which keeps the choice from flickering).
            double insist = 0.2 + 0.6 * personality.CollisionTolerance;
            double best = ClearRun(near, nearGap, count, line) - Math.Abs(line - car.Lateral) * 0.25;
            for (int k = -3; k <= 3; k++)
            {
                double lane = edge * k / 3;
                double score = ClearRun(near, nearGap, count, lane) - Math.Abs(lane - line) * insist - Math.Abs(lane - car.Lateral) * 0.25;
                if (score > best)
                {
                    best = score;
                    lateralTarget = lane;
                }
            }
        }
        // Being lapped: never across the leader's bows, and easing over to the side away from it
        // (it lifts, below). Not a dive for the edge: that put the cars behind into it.
        if (blue is not null)
        {
            int away = blue.Lateral > car.Lateral ? -1 : 1;
            if ((lateralTarget - car.Lateral) * away < 0) lateralTarget = car.Lateral;
            lateralTarget += away * hw * BlueStep;
        }
        lateralTarget = Math.Min(edge, Math.Max(-edge, lateralTarget));
        // A lapse: off its line and out over the edge of the road.
        double lapsing = Lapse(personality, car.Distance);
        if (lapsing != 0) lateralTarget = lapsing > 0 ? hw + PoCabinetPhysics.RunOff * 0.6 : -(hw + PoCabinetPhysics.RunOff * 0.6);
        // Never turn in on a car that is alongside: hold the lane (but always come back off the
        // grass). A bruiser does it anyway and leans on whoever is there.
        if (personality.Aggression < 0.8 && (lateralTarget > car.Lateral ? right : left)) lateralTarget = Math.Min(edge, Math.Max(-edge, car.Lateral));
        // A divider ahead: pick a side of it (the wild and the aggressive go for the joker lane).
        if (track.Islands.Count > 0) lateralTarget = IslandLane(track, car, lateralTarget, personality.Aggression >= 0.5 || personality.Wildness >= 0.15, left, right);

        var p = track.PointAt(car.Along + look);
        double tx = p.X + -p.Ty * lateralTarget;
        double ty = p.Y + p.Tx * lateralTarget;
        double desired = PoCabinetDetMath.Atan2(ty - car.Y, tx - car.X);
        double err = PoCabinetDetMath.WrapAngle(desired - car.Heading);
        // A smooth driver feeds the lock in; a twitchy one saws at it and weaves.
        double steer = Math.Min(1, Math.Max(-1, err * (1.8 + 1.6 * personality.Twitch)));
        if (v < 0) steer = -steer; // rolling backwards inverts the lock (see PoCabinetPhysics.Step)
        // Nose into a barrier or a divider, facing well away from its line and barely moving:
        // back out (the brake at a standstill is reverse, and reversing turns the tail the other way).
        if ((err > 1.2 || err < -1.2) && v < 6 && v > -PoCabinetPhysics.ReverseMax) return new PoCabinetControls(0, 1, steer);
        // Spun and rolling on the wrong way: no throttle into the oncoming field; it turns round on
        // the lock and what speed it has. (Braking it to a stop instead left cars parked across
        // the road.)
        if ((err > WrongWay || err < -WrongWay) && v >= 6) return new PoCabinetControls(0, 0, steer);

        // Speed. A bent car has less grip than it set out with and plans its corners (and a little
        // of its pace) on what is left; a lapse has it believing in grip that is not there.
        double health = 1 - PoCabinetPhysics.GripLoss * car.Damage;
        double pace = maxSpeed * (1 - DamagePace * car.Damage);
        double margin = (0.55 + corneringSkill * 0.4) * (lapsing != 0 ? Math.Abs(lapsing) : 1);
        double inside = track.Islands.Count > 0 ? InsideOfIsland(track, car, lateralTarget) : 0;
        // A late braker looks 0.7 s up the road for its corner, a cautious one 1.3 s, and brakes
        // where the braking curve it plans on (harder, the later the braker) meets the corner.
        double cornerSpeed = CornerLimit(track, car, grip * health, margin, 1.3 - 0.6 * personality.BrakingAggression, inside,
            BrakePlan + BrakePlanLate * personality.BrakingAggression);
        double target = Math.Min(pace, cornerSpeed);
        // What it brakes for: the corner and the traffic. Its own pace it only lifts for, so a
        // descent can carry it on, up to RunOn over (a finished car parking, at 0, stops).
        double limit = Math.Min(cornerSpeed, pace > 0 ? pace + RunOn : 0);
        if (blocker is not null)
        {
            // The car ahead in this lane: no faster than can still be braked down to its speed
            // in the room there is, and a little under it once nose to tail. Its speed is how fast
            // it is going this car's way: a car sideways or pointing back is a car stopped. Never
            // negative: brake at a standstill is the reverse gear. An aggressive driver follows
            // closer than the cars are long, and bumps.
            double room = blockGap - (FollowGap - 12 * personality.Aggression);
            double vb = Math.Max(0, SpeedAlong(blocker, hx, hy));
            double follow = room > 0 ? Math.Sqrt(vb * vb + 2 * FollowDecel * room) : Math.Max(0, vb - 15);
            target = Math.Min(target, follow);
            limit = Math.Min(limit, follow);
        }
        // Being lapped: a lift to let the leader by.
        if (blue is not null) target = target * BlueLift;

        double throttle = v < target - 3 ? 1 : v < target ? 0.35 : 0;
        double brake = v > limit + 4
            ? Math.Min(1, Math.Max(0.15, (v - limit) / 18 * (0.6 + personality.BrakingAggression * 0.8)))
            : 0;
        return new PoCabinetControls(throttle, brake, steer);
    }

    /// <summary>
    /// A wrecked car's driver: get it off the racing line to the barrier on the side it is
    /// nearer, on what limp the engine has left (<see cref="PoCabinetPhysics.Step"/> caps it),
    /// then stop it there. Mirrors physics.js <c>wreckControls</c>.
    /// </summary>
    public static PoCabinetControls Wrecked(PoCabinetTrack track, PoCabinetCarBody car)
    {
        double v = car.Speed;
        int seg = car.SegHint >= 0 ? car.SegHint : track.IndexAt(car.Along);
        int side = car.Lateral < 0 ? -1 : 1;
        double target = side * (track.HalfWidthAt(seg) + PoCabinetPhysics.RunOffAt(track, seg, side) * 0.7);
        var p = track.PointAt(car.Along + 30 + Math.Abs(v) * 0.3);
        double tx = p.X + -p.Ty * target;
        double ty = p.Y + p.Tx * target;
        double steer = Math.Min(1, Math.Max(-1, PoCabinetDetMath.WrapAngle(PoCabinetDetMath.Atan2(ty - car.Y, tx - car.X) - car.Heading) * 2.4));
        if (v < 0) steer = -steer;
        bool clear = Math.Abs(car.Lateral) > track.HalfWidthAt(seg) + PoCabinetPhysics.WreckClear;
        return new PoCabinetControls(clear ? 0 : 1, clear && v > 0.5 ? 0.6 : 0, steer);
    }

    /// <summary>True when cars <paramref name="a"/> and <paramref name="b"/> are both beside the same
    /// road divider, on opposite sides of it. Mirrors physics.js <c>splitBy</c>.</summary>
    private static bool SplitBy(PoCabinetTrack track, PoCabinetCarBody a, PoCabinetCarBody b)
    {
        if (a.SegHint < 0 || b.SegHint < 0) return false;
        int k = track.IslandIndexAt(a.SegHint);
        if (k < 0 || track.IslandIndexAt(b.SegHint) != k) return false;
        var s = track.Islands[k];
        double mid = (s.LatFrom + s.LatTo) * 0.5;
        return (a.Lateral < mid) != (b.Lateral < mid);
    }

    /// <summary>
    /// A road divider within <see cref="IslandLook"/> ahead (or alongside): keep the lane target on
    /// one side of it, clear of its ends. A car keeps to the side it is on (a field swapping sides
    /// in front of the nose is a pile-up); a driver who goes for the joker (<paramref name="joker"/>)
    /// crosses to the short side if it is still well short of the nose and nobody is alongside on
    /// that side. Mirrors physics.js <c>islandLane</c>.
    /// </summary>
    private static double IslandLane(PoCabinetTrack track, PoCabinetCarBody car, double target, bool joker, bool left, bool right)
    {
        double half = track.Length * 0.5;
        foreach (var s in track.Islands)
        {
            double d = s.FromAlong - car.Along;
            if (d > half) d -= track.Length;
            else if (d < -half) d += track.Length;
            double len = s.ToAlong - s.FromAlong;
            if (d > IslandLook || d < -len) continue;
            double mid = (s.LatFrom + s.LatTo) * 0.5;
            int side = car.Lateral < mid ? -1 : 1;
            if (joker && d > IslandLook * 0.4 && side != s.ShortSide && !(s.ShortSide > 0 ? right : left)) side = s.ShortSide;
            double lo = side < 0 ? -s.HalfWidth * 0.85 : s.LatTo + IslandClear;
            double hi = side < 0 ? s.LatFrom - IslandClear : s.HalfWidth * 0.85;
            // The middle of the lane, not its edges: on a bend the line a car steers along cuts in
            // toward the inside, and an edge an inch off the divider is a car grinding along it.
            double m = (hi - lo) * 0.2;
            return Math.Min(hi - m, Math.Max(lo + m, target));
        }
        return target;
    }

    /// <summary>
    /// How far to the inside of the bend a car beside (or about to be beside) a road divider is:
    /// its lane is the short side's, the inside, a tighter radius than the centerline's. 0 for any
    /// other car. Mirrors physics.js <c>insideOfIsland</c>.
    /// </summary>
    private static double InsideOfIsland(PoCabinetTrack track, PoCabinetCarBody car, double target)
    {
        double half = track.Length * 0.5;
        foreach (var s in track.Islands)
        {
            double d = s.FromAlong - car.Along;
            if (d > half) d -= track.Length;
            else if (d < -half) d += track.Length;
            if (d > IslandLook || d < -(s.ToAlong - s.FromAlong)) continue;
            double lat = Math.Max(Math.Abs(car.Lateral), Math.Abs(target));
            double mid = (s.LatFrom + s.LatTo) * 0.5;
            return (target - mid) * s.ShortSide > 0 ? lat : 0;
        }
        return 0;
    }

    /// <summary>
    /// A driver's lapse: 0 while it is driving properly, else how far over the limit it thinks
    /// the grip goes (1.5 to 2.4 times), signed by the side of the road it is about to leave
    /// (+ = right). While it lasts the car misses its line, runs wide onto the run-off on that
    /// side and carries too much speed into whatever corner is next; then it gathers it up.
    /// One draw per <see cref="LapseStretch"/> of race distance, live for the first
    /// <see cref="LapseLength"/> of it and never off the grid: a pure hash of the driver's seed
    /// and the stretch. No state, no RNG, integer and exact double arithmetic only, so the
    /// browser and the lap verifier draw the same lapses. Mirrors physics.js <c>lapse</c>.
    /// </summary>
    private static double Lapse(PoCabinetPersonality personality, double distance)
    {
        if (!(personality.Wildness > 0) || distance < LapseStretch) return 0;
        double at = distance + personality.Seed * 53;
        double stretch = Math.Floor(at / LapseStretch);
        if (at - stretch * LapseStretch > LapseLength) return 0;
        unchecked
        {
            uint h = ((uint)(int)stretch ^ ((uint)personality.Seed * 0x9E3779B1u)) * 0x85EBCA6Bu;
            h ^= h >> 13;
            h *= 0xC2B2AE35u;
            h ^= h >> 16;
            if ((h & 0xffff) / 65535.0 >= personality.Wildness) return 0;
            double over = 1.5 + ((h >> 16) & 0xff) / 255.0 * 0.9;
            return h >> 31 != 0 ? over : -over;
        }
    }

    /// <summary>
    /// The speed limit for the corners in braking range: for each curvature sample within
    /// <paramref name="reach"/> seconds of road, the speed it can still brake down to that sample's
    /// corner speed from at <paramref name="decel"/> (the braking curve sqrt(vApex² + 2·decel·distance)),
    /// and the lowest of them. A corner up the road costs nothing until its braking point comes.
    /// Mirrors physics.js <c>cornerLimit</c>.
    /// </summary>
    private static double CornerLimit(PoCabinetTrack track, PoCabinetCarBody car, double grip, double margin, double reach, double inside, double decel)
    {
        double v = car.Speed;
        // Capped at a turn as tight as the road is wide: the centerline has kinks sharper than
        // that (Mar-a-Lago's last bend, a few samples long) which a car simply cuts across, and
        // braking for them parked a 100-car field on the start line.
        double cap = 1 / track.HalfWidth;
        double to = car.Along + 30 + Math.Abs(v) * reach;
        double limit = double.MaxValue;
        for (double d = car.Along + 5; d <= to; d += PoCabinetTrack.CurvatureSampleStep)
        {
            double kappa = Math.Min(cap, track.CurvatureAt(track.IndexAt(d)));
            // A car on the inside of a split runs a tighter radius than the centerline's.
            if (inside > 0) kappa = kappa / Math.Max(0.4, 1 - kappa * inside);
            double apex = PoCabinetPhysics.GripAccel * grip * margin / Math.Max(kappa, 1e-5);
            double allowed = Math.Sqrt(apex + 2 * decel * (d - car.Along));
            if (allowed < limit) limit = allowed;
        }
        return limit;
    }

    /// <summary>How fast <paramref name="b"/> is going along the unit direction (<paramref name="dx"/>,
    /// <paramref name="dy"/>): its forward speed and its sideways slide both count, so a car that has
    /// spun round is not "pulling away". Mirrors physics.js <c>speedAlong</c>.</summary>
    private static double SpeedAlong(PoCabinetCarBody b, double dx, double dy)
    {
        double bx = PoCabinetDetMath.Cos(b.Heading), by = PoCabinetDetMath.Sin(b.Heading);
        return (bx * b.Speed - by * b.Slip) * dx + (by * b.Speed + bx * b.Slip) * dy;
    }

    /// <summary><see cref="SpeedAlong"/> the road where <paramref name="b"/> is. Mirrors physics.js <c>roadSpeed</c>.</summary>
    private static double RoadSpeed(PoCabinetTrack track, PoCabinetCarBody b)
    {
        int seg = b.SegHint >= 0 ? b.SegHint : track.IndexAt(b.Along);
        return SpeedAlong(b, track.TangentX(seg), track.TangentY(seg));
    }

    /// <summary>Clear road ahead in lane <paramref name="lateral"/> (capped at <see cref="Range"/>).</summary>
    private static double ClearRun(PoCabinetCarBody[] near, double[] nearGap, int count, double lateral)
    {
        double run = Range;
        for (int i = 0; i < count; i++)
        {
            if (nearGap[i] < run && Math.Abs(near[i].Lateral - lateral) < 20) run = nearGap[i];
        }
        return run;
    }
}
