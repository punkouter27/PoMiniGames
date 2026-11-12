using System.Runtime.CompilerServices;

namespace PoMiniGames.Shared.Games;

// ────────────────────────────  Rules  ─────────────────────────────
//
// The one implementation of "place a mark on a grid, line up N to win" that both
// the client boards and the online match service apply. ConnectFive and TicTacToe
// differ only in geometry and in whether gravity decides the row, so they are two
// subclasses of one rule set: a move the server accepts is a move the client
// would have drawn, and there is no second copy of the win scan to drift.

/// <summary>
/// Pure rules over a flat, row-major <c>byte[Rows * Cols]</c> where a cell holds
/// <see cref="Empty"/>, <see cref="First"/> or <see cref="Second"/>. Row 0 is the top.
/// Subclasses fix the geometry and decide where a move lands.
/// </summary>
public abstract class GridGameRules
{
    public const byte Empty = 0;
    public const byte First = 1;
    public const byte Second = 2;

    public abstract int Rows { get; }
    public abstract int Cols { get; }
    public abstract int WinLength { get; }
    public int CellCount => Rows * Cols;

    /// <summary>
    /// The row a mark requested at (<paramref name="row"/>, <paramref name="col"/>) would
    /// occupy, or -1 when the move is illegal. Gravity games ignore <paramref name="row"/>.
    /// </summary>
    public abstract int ResolveRow(ReadOnlySpan<byte> cells, int row, int col);

    public static bool IsFull(ReadOnlySpan<byte> cells)
    {
        foreach (var cell in cells)
        {
            if (cell == Empty) return false;
        }
        return true;
    }

    /// <summary>
    /// Flat cell indices of the first <see cref="WinLength"/>-in-a-row found for
    /// <paramref name="mark"/>, in line order, or <c>null</c> when there is none.
    /// </summary>
    /// <remarks>
    /// Scans every anchor cell in four directions and validates the FULL window from
    /// the anchor (i = 0). An earlier client-side copy started at i = 1, so a run of
    /// four plus an unchecked anchor reported a "win" whose fifth highlighted cell was
    /// empty — the reason the window starts at zero is that bug.
    /// </remarks>
    public int[]? FindWin(ReadOnlySpan<byte> cells, byte mark)
    {
        if (mark == Empty) throw new ArgumentException("Cannot check a win for the empty cell.", nameof(mark));
        ReadOnlySpan<(int dr, int dc)> directions = [(0, 1), (1, 0), (1, 1), (1, -1)];
        int rows = Rows, cols = Cols, len = WinLength;

        for (int r = 0; r < rows; r++)
        {
            for (int c = 0; c < cols; c++)
            {
                if (cells[r * cols + c] != mark) continue;
                foreach (var (dr, dc) in directions)
                {
                    var endR = r + dr * (len - 1);
                    var endC = c + dc * (len - 1);
                    if (endR < 0 || endR >= rows || endC < 0 || endC >= cols) continue;

                    bool valid = true;
                    for (int i = 1; i < len; i++)
                    {
                        if (cells[(r + dr * i) * cols + (c + dc * i)] != mark) { valid = false; break; }
                    }
                    if (!valid) continue;

                    var line = new int[len];
                    for (int i = 0; i < len; i++) line[i] = (r + dr * i) * cols + (c + dc * i);
                    return line;
                }
            }
        }
        return null;
    }
}

/// <summary>Connect Five: 9×9, five in a row, discs fall to the lowest empty row of their column.</summary>
public sealed class ConnectFiveRules : GridGameRules
{
    public static readonly ConnectFiveRules Instance = new();

    public const int BoardRows = 9;
    public const int BoardCols = 9;
    public const int BoardWinLength = 5;

    public override int Rows => BoardRows;
    public override int Cols => BoardCols;
    public override int WinLength => BoardWinLength;

    /// <summary>The row a disc dropped in <paramref name="col"/> lands on, or -1 when the column is full.</summary>
    public static int TargetRow(ReadOnlySpan<byte> cells, int col)
    {
        if (col < 0 || col >= BoardCols) return -1;
        for (int r = BoardRows - 1; r >= 0; r--)
        {
            if (cells[r * BoardCols + col] == Empty) return r;
        }
        return -1;
    }

    public override int ResolveRow(ReadOnlySpan<byte> cells, int row, int col) => TargetRow(cells, col);
}

/// <summary>Tic-Tac-Toe as this app plays it: 6×6, four in a row, any empty cell.</summary>
public sealed class TicTacToeRules : GridGameRules
{
    public static readonly TicTacToeRules Instance = new();

    public const int BoardSize = 6;
    public const int BoardWinLength = 4;

    public override int Rows => BoardSize;
    public override int Cols => BoardSize;
    public override int WinLength => BoardWinLength;

    public override int ResolveRow(ReadOnlySpan<byte> cells, int row, int col)
    {
        if (row < 0 || row >= BoardSize || col < 0 || col >= BoardSize) return -1;
        return cells[row * BoardSize + col] == Empty ? row : -1;
    }
}

// ──────────────────────────  Online wire  ─────────────────────────
//
// Contracts for the turn-match hubs (/connectfive/hub, /tictactoe/hub). Enums
// cross the wire as camelCase strings (Program.cs AddJsonProtocol on the server,
// HubConnectionFactory on the client). No lobby, no host, no ready check: a
// two-seat turn game only needs a quick-match queue — the first two arrivals are
// paired and play. "First" is whichever seat moves first in the current game;
// a rematch swaps the seats, so the same player is Second next time.

public enum TurnMatchSide
{
    First = 1,
    Second = 2,
}

public enum TurnMatchStatus
{
    InProgress,
    FirstWon,
    SecondWon,
    Draw,
}

public enum TurnMatchEndReason
{
    None,
    Line,
    BoardFull,
    /// <summary>A seat left the match (explicit Leave) while it was in progress.</summary>
    Forfeit,
    /// <summary>A seat dropped and did not come back inside the reconnect grace window.</summary>
    Disconnect,
}

/// <summary>One of the two seats, as every viewer of the match sees it. No connection ids or tokens.</summary>
public sealed record TurnMatchSeat(
    string DisplayName,
    bool IsGuest,
    TurnMatchSide Side,
    bool Connected,
    bool WantsRematch);

/// <summary>
/// Sent to each seat individually when a game begins (first pairing and every
/// rematch). <see cref="SeatToken"/> is the private handle a client presents to
/// <c>Rejoin</c> after a reconnect; it never appears in the shared state.
/// </summary>
public sealed record TurnMatchStart(
    string MatchId,
    int GameNumber,
    string SeatToken,
    TurnMatchSide YourSide,
    TurnMatchSeat First,
    TurnMatchSeat Second);

public sealed record TurnMatchMove(int Row, int Col, TurnMatchSide Side);

/// <summary>
/// Full authoritative snapshot, broadcast to both seats after every change.
/// <see cref="Cells"/> is the flat <see cref="GridGameRules"/> board; <see cref="WinCells"/>
/// holds flat indices of the winning line when there is one. A client that is exactly
/// one move behind applies <see cref="LastMove"/> so its placement animation plays;
/// any other gap rebuilds from <see cref="Cells"/>.
/// </summary>
public sealed record TurnMatchState(
    string MatchId,
    int GameNumber,
    byte[] Cells,
    int MoveCount,
    TurnMatchSide Turn,
    TurnMatchStatus Status,
    TurnMatchEndReason EndReason,
    TurnMatchMove? LastMove,
    int[] WinCells,
    TurnMatchSeat First,
    TurnMatchSeat Second,
    DateTimeOffset UpdatedUtc)
{
    public TurnMatchSeat SeatOf(TurnMatchSide side) => side == TurnMatchSide.First ? First : Second;
    public TurnMatchSeat OpponentOf(TurnMatchSide side) => side == TurnMatchSide.First ? Second : First;
}

/// <summary>Reply to <c>FindMatch</c>. When <see cref="Matched"/> is true a <c>matchStarted</c> event follows.</summary>
public sealed record TurnMatchQueueStatus(bool Matched, int Waiting);

/// <summary>Reply to <c>Rejoin</c>: the seat's private start record plus the current board.</summary>
public sealed record TurnMatchRejoinResult(TurnMatchStart Start, TurnMatchState State);
