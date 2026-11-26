using Azure.Data.Tables;

namespace PoMiniGames.Infrastructure.Services;

/// <summary>
/// Everything that varies between one game's high-score table and another's, captured as data:
/// where rows live (<see cref="Table"/> / <see cref="Partition"/>), how an entry is normalised
/// (<see cref="Sanitize"/>), how it maps to and from a <see cref="TableEntity"/>
/// (<see cref="ToFields"/> / <see cref="FromEntity"/>), which fields identify a row
/// (<see cref="RowKeyFields"/>), and how a leaderboard is ranked (<see cref="Rank"/>). The generic
/// save/get flow in <see cref="StorageService"/> is identical for every game; only this descriptor
/// changes.
/// </summary>
/// <remarks>
/// Pattern: Strategy. Each game supplies a descriptor as the strategy; one generic persistence
/// algorithm consumes it. Adding a game becomes one descriptor instead of a new pair of
/// near-duplicate methods, concentrating the persistence contract in a single place.
/// </remarks>
/// <param name="RowKeyFields">
/// The <see cref="ToFields"/> keys hashed into the RowKey — the row's identity. List only
/// <em>immutable content</em>: naming a mutable field (a timestamp) splits retries of one score
/// across rows, and naming an unvalidated field hands a caller a free row-multiplier. Anything
/// omitted is still persisted, just not part of identity.
/// <para>
/// This is stated per descriptor rather than inferred, because inference here is a trap: deriving
/// it by probing <c>ToFields(default!)</c> made every board's lambda silently null-sensitive, and a
/// board whose lambda dereferenced its argument (MarbleRace did) threw on <em>every</em> save.
/// Changing these values re-keys the board — existing rows keep their old RowKey and stop
/// collapsing with new submissions.
/// </para>
/// </param>
internal sealed record HighScoreDescriptor<T>(
    string Table,
    string Partition,
    Func<T, T> Sanitize,
    Func<T, IDictionary<string, object?>> ToFields,
    Func<TableEntity, T> FromEntity,
    IReadOnlyList<string> RowKeyFields,
    Func<IEnumerable<T>, IEnumerable<T>> Rank)
{
    /// <summary>
    /// Optional veto, evaluated against the row already in storage before it is overwritten.
    /// Returning false leaves the stored row untouched.
    /// <para>
    /// A board whose <see cref="RowKeyFields"/> identify the <em>player</em> rather than the run
    /// keeps one row per player, so every submission targets the same row — and without a veto a
    /// later, worse run would overwrite a better one. Boards keyed by run don't need this.
    /// </para>
    /// </summary>
    public Func<TableEntity, IDictionary<string, object?>, bool>? ShouldOverwrite { get; init; }
}
