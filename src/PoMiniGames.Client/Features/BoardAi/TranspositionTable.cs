namespace PoMiniGamesClient.Features.BoardAi;

public enum BoundKind : byte
{
    None = 0,
    Exact = 1,
    Lower = 2,
    Upper = 3,
}

/// <summary>
/// Fixed-size Zobrist-keyed transposition table. Each slot keeps the full key, a depth, a
/// score with its bound kind and the best move, so a hit can both cut off and order moves.
/// Replacement is by depth (a deeper result survives a shallower one) with an age stamp so
/// entries from earlier searches are freely overwritten. The size is a power of two and
/// never grows.
/// </summary>
public sealed class TranspositionTable
{
    private struct Entry
    {
        public ulong Key;
        public int Score;
        public short Move;
        public sbyte Depth;
        public BoundKind Bound;
        public byte Age;
    }

    private readonly Entry[] _slots;
    private readonly int _mask;
    private byte _age;

    public TranspositionTable(int sizeLog2 = 16)
    {
        _slots = new Entry[1 << sizeLog2];
        _mask = _slots.Length - 1;
    }

    public int Capacity => _slots.Length;

    public void NewSearch() => _age++;

    public bool Probe(ulong key, out int depth, out int score, out BoundKind bound, out int move)
    {
        ref var e = ref _slots[(int)(key & (ulong)_mask)];
        if (e.Bound != BoundKind.None && e.Key == key)
        {
            depth = e.Depth;
            score = e.Score;
            bound = e.Bound;
            move = e.Move;
            return true;
        }
        depth = 0;
        score = 0;
        bound = BoundKind.None;
        move = -1;
        return false;
    }

    public void Store(ulong key, int depth, int score, BoundKind bound, int move)
    {
        ref var e = ref _slots[(int)(key & (ulong)_mask)];
        var occupied = e.Bound != BoundKind.None;
        var sameKey = occupied && e.Key == key;
        if (!sameKey && occupied && e.Age == _age && depth < e.Depth) return;
        if (sameKey && depth < e.Depth && bound != BoundKind.Exact) return;
        e.Key = key;
        e.Depth = (sbyte)Math.Clamp(depth, sbyte.MinValue, sbyte.MaxValue);
        e.Score = score;
        e.Bound = bound;
        e.Age = _age;
        if (move >= 0) e.Move = (short)move;
        else if (!sameKey) e.Move = -1;
    }
}
