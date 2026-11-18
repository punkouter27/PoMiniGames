namespace PoMiniGamesClient.Features.BoardAi;

/// <summary>
/// Mutable make/undo board for the search engines (the immutable game boards allocate on
/// every Place, which is far too slow inside a search). Cells are 0 empty, 1 and 2 the two
/// players; the hash is Zobrist and includes the side to move.
/// </summary>
public sealed class GridPosition
{
    private readonly int[] _history;
    private int _depth;

    public GridPosition(GridGeometry geometry)
    {
        Geometry = geometry;
        Cells = new byte[geometry.Total];
        Tops = new int[geometry.Cols];
        Array.Fill(Tops, geometry.Rows - 1);
        _history = new int[geometry.Total + 1];
        ToMove = 1;
    }

    public GridGeometry Geometry { get; }
    public byte[] Cells { get; }

    /// <summary>Gravity games: the row a disc dropped in each column lands on (-1 = full).</summary>
    public int[] Tops { get; }
    public ulong Hash { get; private set; }
    public int ToMove { get; private set; }
    public int Count { get; private set; }

    public static GridPosition FromCells(GridGeometry geometry, ReadOnlySpan<byte> cells, int toMove)
    {
        var pos = new GridPosition(geometry);
        for (int i = 0; i < cells.Length; i++)
        {
            if (cells[i] == 0) continue;
            pos.Cells[i] = cells[i];
            pos.Hash ^= geometry.Zobrist[i * 3 + cells[i]];
            pos.Count++;
        }
        if (geometry.Gravity)
        {
            for (int c = 0; c < geometry.Cols; c++)
            {
                var row = geometry.Rows - 1;
                while (row >= 0 && pos.Cells[row * geometry.Cols + c] != 0) row--;
                pos.Tops[c] = row;
            }
        }
        pos.ToMove = toMove;
        if (toMove == 2) pos.Hash ^= geometry.SideKey;
        return pos;
    }

    /// <summary>Hash of the left-right mirror image (opening-book symmetry).</summary>
    public ulong MirrorHash()
    {
        ulong h = 0;
        for (int i = 0; i < Cells.Length; i++)
        {
            if (Cells[i] != 0) h ^= Geometry.Zobrist[Geometry.MirrorCell[i] * 3 + Cells[i]];
        }
        if (ToMove == 2) h ^= Geometry.SideKey;
        return h;
    }

    public bool IsFull => Count == Geometry.Total;

    public bool Make(int cell)
    {
        var won = MakesLine(cell, ToMove);
        Cells[cell] = (byte)ToMove;
        Hash ^= Geometry.Zobrist[cell * 3 + ToMove] ^ Geometry.SideKey;
        if (Geometry.Gravity) Tops[cell % Geometry.Cols]--;
        _history[_depth++] = cell;
        Count++;
        ToMove = 3 - ToMove;
        return won;
    }

    public void Undo()
    {
        var cell = _history[--_depth];
        ToMove = 3 - ToMove;
        Hash ^= Geometry.Zobrist[cell * 3 + ToMove] ^ Geometry.SideKey;
        Cells[cell] = 0;
        if (Geometry.Gravity) Tops[cell % Geometry.Cols]++;
        Count--;
    }

    /// <summary>Hands the move to the other side without playing (threat analysis).</summary>
    public void Pass()
    {
        ToMove = 3 - ToMove;
        Hash ^= Geometry.SideKey;
    }

    /// <summary>Would a piece of <paramref name="player"/> on <paramref name="cell"/> complete a line?</summary>
    public bool MakesLine(int cell, int player)
    {
        int cols = Geometry.Cols, rows = Geometry.Rows, win = Geometry.Win;
        int r = cell / cols, c = cell % cols;
        foreach (var (dr, dc) in GridGeometry.Dirs)
        {
            int n = 1;
            for (int rr = r + dr, cc = c + dc; rr >= 0 && rr < rows && cc >= 0 && cc < cols && Cells[rr * cols + cc] == player; rr += dr, cc += dc) n++;
            for (int rr = r - dr, cc = c - dc; rr >= 0 && rr < rows && cc >= 0 && cc < cols && Cells[rr * cols + cc] == player; rr -= dr, cc -= dc) n++;
            if (n >= win) return true;
        }
        return false;
    }

    /// <summary>
    /// Fills <paramref name="buffer"/> with the playable cells and returns the count.
    /// Gravity: one per open column. Free placement: empty cells touching a mark (the centre
    /// block on an empty board), which always contains every cell that can win or block.
    /// </summary>
    public int GenMoves(int[] buffer)
    {
        var g = Geometry;
        int n = 0;
        if (g.Gravity)
        {
            for (int c = 0; c < g.Cols; c++)
            {
                if (Tops[c] >= 0) buffer[n++] = Tops[c] * g.Cols + c;
            }
            return n;
        }
        if (Count == 0)
        {
            for (int i = 0; i < g.Total; i++)
            {
                int r = i / g.Cols, c = i % g.Cols;
                if (Math.Abs(2 * r - (g.Rows - 1)) <= 1 && Math.Abs(2 * c - (g.Cols - 1)) <= 1) buffer[n++] = i;
            }
            return n;
        }
        for (int i = 0; i < g.Total; i++)
        {
            if (Cells[i] != 0) continue;
            foreach (var nb in g.Neighbors[i])
            {
                if (Cells[nb] == 0) continue;
                buffer[n++] = i;
                break;
            }
        }
        return n;
    }
}
