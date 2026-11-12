using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoRacer;

public readonly record struct Vec2(double X, double Y)
{
    public static Vec2 operator +(Vec2 a, Vec2 b) => new(a.X + b.X, a.Y + b.Y);
    public static Vec2 operator -(Vec2 a, Vec2 b) => new(a.X - b.X, a.Y - b.Y);
    public static Vec2 operator *(Vec2 a, double s) => new(a.X * s, a.Y * s);
    public double LengthSquared() => X * X + Y * Y;
    public double Length() => Math.Sqrt(LengthSquared());
}

public sealed class PoRacerBoostPadDefinition
{
    public required Vec2 Position { get; init; }
    public required double Radius { get; init; } = 40.0;
    public required double DirectionAngle { get; init; }
    public double BoostMultiplier { get; init; } = 1.35;
    public double DurationSeconds { get; init; } = 1.8;

    public bool Contains(Vec2 p)
    {
        double dx = p.X - Position.X;
        double dy = p.Y - Position.Y;
        return (dx * dx + dy * dy) <= (Radius * Radius);
    }
}

public sealed class PoRacerSurfaceZoneDefinition
{
    public required string Name { get; init; }
    public required SurfaceKind SurfaceType { get; init; }
    public required Vec2 Center { get; init; }
    public required double Radius { get; init; }
    public double GripMultiplier { get; init; } = 0.68;

    public bool Contains(Vec2 p)
    {
        double dx = p.X - Center.X;
        double dy = p.Y - Center.Y;
        return (dx * dx + dy * dy) <= (Radius * Radius);
    }
}

public sealed class PoRacerTrackData
{
    public required string Id { get; init; }
    public required string DisplayName { get; init; }
    public required string Description { get; init; }
    public required double TrackWidth { get; init; }
    public required IReadOnlyList<Vec2> Centerline { get; init; }
    public required IReadOnlyList<(Vec2 a, Vec2 b)> Walls { get; init; }
    public required IReadOnlyList<PoRacerBoostPadDefinition> BoostPads { get; init; }
    public required IReadOnlyList<PoRacerSurfaceZoneDefinition> SurfaceZones { get; init; }
    public required string EnvironmentTheme { get; init; }
    public bool HasSandZones => SurfaceZones.Any(z => z.SurfaceType == SurfaceKind.Sand);
}
