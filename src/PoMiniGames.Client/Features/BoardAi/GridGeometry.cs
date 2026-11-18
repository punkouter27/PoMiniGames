namespace PoMiniGamesClient.Features.BoardAi;

/// <summary>
/// Static shape of a k-in-a-row grid game (rows, cols, run length, gravity) plus everything
/// the engines precompute from it: every winning window, Zobrist keys, neighbours and
/// centre ranks. ConnectFive (gravity) and TicTacToe (free placement) share one engine
/// through this type.
/// </summary>
public sealed class GridGeometry
{
    private static readonly (int Dr, int Dc)[] Directions = [(0, 1), (1, 0), (1, 1), (1, -1)];

    public GridGeometry(int rows, int cols, int win, bool gravity, ulong seed)
    {
        Rows = rows;
        Cols = cols;
        Win = win;
        Gravity = gravity;
        Total = rows * cols;

        var windows = new List<int>();
        foreach (var (dr, dc) in Directions)
        {
            for (int r = 0; r < rows; r++)
            {
                for (int c = 0; c < cols; c++)
                {
                    var er = r + dr * (win - 1);
                    var ec = c + dc * (win - 1);
                    if (er < 0 || er >= rows || ec < 0 || ec >= cols) continue;
                    for (int i = 0; i < win; i++) windows.Add((r + dr * i) * cols + c + dc * i);
                }
            }
        }
        Windows = [.. windows];
        WindowCount = windows.Count / win;

        var state = seed;
        Zobrist = new ulong[Total * 3];
        for (int i = 0; i < Zobrist.Length; i++) Zobrist[i] = Mix(ref state);
        SideKey = Mix(ref state);

        MirrorCell = new int[Total];
        CenterRank = new int[Total];
        Neighbors = new int[Total][];
        var maxDist = (rows - 1) + (cols - 1);
        for (int cell = 0; cell < Total; cell++)
        {
            int r = cell / cols, c = cell % cols;
            MirrorCell[cell] = r * cols + (cols - 1 - c);
            var dist = Math.Abs(2 * r - (rows - 1)) + Math.Abs(2 * c - (cols - 1));
            CenterRank[cell] = 9 - Math.Min(9, dist * 9 / Math.Max(1, maxDist));
            var near = new List<int>(8);
            for (int rr = Math.Max(0, r - 1); rr <= Math.Min(rows - 1, r + 1); rr++)
            {
                for (int cc = Math.Max(0, c - 1); cc <= Math.Min(cols - 1, c + 1); cc++)
                {
                    if (rr != r || cc != c) near.Add(rr * cols + cc);
                }
            }
            Neighbors[cell] = [.. near];
        }
    }

    public int Rows { get; }
    public int Cols { get; }
    public int Win { get; }
    public int Total { get; }
    public bool Gravity { get; }
    public int WindowCount { get; }

    /// <summary>Every winning window, flattened: <see cref="Win"/> cell indices each.</summary>
    public int[] Windows { get; }
    public ulong[] Zobrist { get; }
    public ulong SideKey { get; }
    public int[] MirrorCell { get; }

    /// <summary>0 (corner) to 9 (centre): used as the last move-ordering tie-break.</summary>
    public int[] CenterRank { get; }
    public int[][] Neighbors { get; }

    public static (int Dr, int Dc)[] Dirs => Directions;

    private static ulong Mix(ref ulong state)
    {
        // splitmix64: tiny, deterministic, good avalanche for hash keys.
        unchecked
        {
            state += 0x9E3779B97F4A7C15UL;
            var z = state;
            z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9UL;
            z = (z ^ (z >> 27)) * 0x94D049BB133111EBUL;
            return z ^ (z >> 31);
        }
    }
}
