namespace PoMiniGames.Shared.Games.PoMule;

public enum Terrain : byte { Plains, River, Mountain, Crater, Town }

/// <summary>One tile of the planet.</summary>
/// <param name="Peaks">1–3 on mountains, 0 elsewhere. More peaks, more Smithore.</param>
/// <param name="Crystite">Hidden richness, 0–4. Revealed by an assay.</param>
public readonly record struct Plot(Terrain Terrain, byte Peaks, byte Crystite);

/// <summary>
/// The planet: 24 columns that wrap east–west and 9 rows that do not (212 non-town plots,
/// enough for 16 colonists to claim a plot in every month plus all six even-month auctions).
/// </summary>
public sealed class PoMuleMap
{
    public const int Columns = 24;
    public const int Rows = 9;

    /// <summary>Row index of the four town hubs.</summary>
    public const int TownRow = 4;

    public static readonly IReadOnlyList<int> TownColumns = [2, 8, 14, 20];

    private const int MountainCount = 45;
    private const int CraterCount = 5;

    /// <summary>Row-major: index = row × <see cref="Columns"/> + column.</summary>
    public Plot[] Plots { get; }

    public PoMuleMap(Plot[] plots) => Plots = plots;

    public Plot this[int column, int row] => Plots[Index(column, row)];

    public static int Index(int column, int row) => row * Columns + Wrap(column);

    public static int Wrap(int column) => ((column % Columns) + Columns) % Columns;

    /// <summary>Shortest east–west distance, going around the seam when that is closer.</summary>
    public static int ColumnDistance(int a, int b)
    {
        var d = Math.Abs(Wrap(a) - Wrap(b));
        return Math.Min(d, Columns - d);
    }

    public static PoMuleMap Generate(PoMuleRng rng)
    {
        var plots = new Plot[Columns * Rows];
        for (var i = 0; i < plots.Length; i++)
            plots[i] = new Plot(Terrain.Plains, 0, (byte)rng.Next(2));

        foreach (var column in TownColumns)
            plots[Index(column, TownRow)] = new Plot(Terrain.Town, 0, 0);

        // Three rivers a third of the globe apart. Each wanders at most two columns from its
        // source, so they never merge.
        var firstRiver = rng.Next(Columns / 3);
        for (var r = 0; r < 3; r++)
        {
            var drift = 0;
            for (var row = 0; row < Rows; row++)
            {
                var i = Index(firstRiver + r * (Columns / 3) + drift, row);
                if (plots[i].Terrain != Terrain.Town)
                    plots[i] = new Plot(Terrain.River, 0, 0);
                drift = Math.Clamp(drift + rng.Next(3) - 1, -2, 2);
            }
        }

        Scatter(plots, rng, MountainCount, crystite => new Plot(Terrain.Mountain, (byte)(1 + rng.Next(3)), crystite));
        Scatter(plots, rng, CraterCount, _ => new Plot(Terrain.Crater, 0, (byte)(1 + rng.Next(3))));
        return new PoMuleMap(plots);
    }

    private static void Scatter(Plot[] plots, PoMuleRng rng, int count, Func<byte, Plot> make)
    {
        while (count > 0)
        {
            var i = rng.Next(plots.Length);
            if (plots[i].Terrain != Terrain.Plains) continue;
            plots[i] = make(plots[i].Crystite);
            count--;
        }
    }
}
