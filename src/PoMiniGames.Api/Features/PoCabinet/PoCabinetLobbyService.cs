using System.Security.Cryptography;
using PoMiniGames.Features.Shared.Lobby;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Features.PoCabinet;

/// <summary>
/// The one in-memory PoCabinet lobby, a <see cref="LobbyRoom{TPlayer}"/>: whoever arrives first
/// hosts, the next arrivals take the free seats up to eight, the host starts, and optional AI
/// drivers (the officials, then field racers) fill the grid out to
/// <see cref="PoCabinetCatalog.OnlineGridSize"/> cars. There are no join codes: everyone who
/// opens the multiplayer page lands here.
///
/// <para>
/// The host's track and AI-driver picks live on the room and are stamped on every seat, so the
/// shared lobby state carries them. Each start mints an internal race code (<see cref="BeginRace"/>)
/// that <c>gameStarted</c> carries and <see cref="PoCabinetRaceHub"/> keys the race by.
/// </para>
/// <para>
/// The lobby outlives its race: <see cref="MarkRaceFinished"/> reopens it with the same roster
/// (that is the rematch), everyone but the host readies up again, and after a race a seat that
/// stays not ready for <see cref="ReadyTimeout"/> is freed (<see cref="SweepUnready"/>, called
/// about once a second by the race registry's timer). The host can kick a seat between races
/// (<see cref="CanKick"/>).
/// </para>
/// </summary>
public sealed class PoCabinetLobbyService : LobbyRoom<PoCabinetLobbyPlayer>
{
    public const int DefaultBots = 3;

    /// <summary>The fixed room code in the lobby state while idle; a running race swaps in its own code.</summary>
    public const string GlobalCode = "LOBBY";

    /// <summary>How long a player may stay not ready in a reopened (rematch) lobby before the seat is freed.</summary>
    public static readonly TimeSpan ReadyTimeout = TimeSpan.FromSeconds(90);

    private readonly TimeProvider _time;
    private readonly Dictionary<string, DateTimeOffset> _unreadySince = new(StringComparer.Ordinal);
    private string _trackId = PoCabinetCatalog.DefaultTrackId;
    private int _botCount = DefaultBots;
    private bool _hasRaced;

    public PoCabinetLobbyService(TimeProvider? time = null)
        : base(GlobalCode, PoCabinetCatalog.CarCount, "Race in progress. You get a seat when it finishes.")
    {
        _time = time ?? TimeProvider.System;
    }

    public override bool CanKick => true;

    /// <summary>The host's track pick for the next race.</summary>
    public string TrackId => WithLock(_ => _trackId);

    /// <summary>The AI drivers the host asked for (the race seats <see cref="PoCabinetLobbyRules.BotSeats"/> of them).</summary>
    public int BotCount => WithLock(_ => _botCount);

    /// <summary>Seat the caller. An empty room starts fresh (default picks, no rematch timeout yet).</summary>
    public (LobbyState<PoCabinetLobbyPlayer> state, string message) Open(string connectionId, string displayName, bool isGuest, string userId) =>
        OpenCore(connectionId, displayName, isGuest, (name, previous, others) =>
        {
            if (others.Count == 0)
            {
                _hasRaced = false;
                _trackId = PoCabinetCatalog.DefaultTrackId;
                _botCount = DefaultBots;
            }
            _unreadySince[connectionId] = _time.GetUtcNow();
            return new PoCabinetLobbyPlayer(connectionId, name, isGuest, false, previous?.Color ?? "", _trackId, _botCount) { UserId = userId };
        });

    /// <summary>Host-only, idle: switch the track for the next race.</summary>
    public bool SetTrack(string connectionId, string? trackId) => WithLock(seats =>
    {
        if (!HostedIdle(connectionId) || !PoCabinetCatalog.IsKnownTrack(trackId)) return false;
        _trackId = PoCabinetCatalog.GetTrack(trackId).Id;
        foreach (var key in seats.Keys.ToList()) seats[key] = seats[key] with { TrackId = _trackId };
        return true;
    });

    /// <summary>Host-only, idle: how many AI drivers join the grid (0 to <see cref="PoCabinetCatalog.MaxBots"/>).</summary>
    public bool SetBots(string connectionId, int count) => WithLock(seats =>
    {
        if (!HostedIdle(connectionId)) return false;
        _botCount = Math.Clamp(count, 0, PoCabinetCatalog.MaxBots);
        foreach (var key in seats.Keys.ToList()) seats[key] = seats[key] with { BotCount = _botCount };
        return true;
    });

    /// <summary>The caller's paint: a paint-shop name or #rrggbb; anything else clears it (client default).</summary>
    public bool SetColor(string connectionId, string? color) => WithLock(seats =>
    {
        if (!seats.TryGetValue(connectionId, out var seat)) return false;
        seats[connectionId] = seat with { Color = SanitizeColor(color) };
        return true;
    });

    /// <summary>Mint the internal race code this start runs under; it is what <c>gameStarted</c> carries.</summary>
    public string BeginRace() => WithLock(_ =>
        GameCode = Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant());

    /// <summary>
    /// The race ended: reopen the lobby with the same roster. Everyone but the host has to ready
    /// up again within <see cref="ReadyTimeout"/>. A <paramref name="raceCode"/> that is not the
    /// running race's changes nothing. True when the lobby reopened.
    /// </summary>
    public bool MarkRaceFinished(string? raceCode = null) => WithLock(seats =>
    {
        if (!IsStarted || (raceCode is not null && GameCode != raceCode)) return false;
        End();
        _hasRaced = true;
        var now = _time.GetUtcNow();
        foreach (var key in seats.Keys) _unreadySince[key] = now;
        return true;
    });

    /// <summary>
    /// A reopened (rematch) lobby frees the seats of players who have not readied up for
    /// <see cref="ReadyTimeout"/>; a lobby that has not raced yet, or is racing, is left alone.
    /// </summary>
    public IReadOnlyList<Unseated> SweepUnready() => WithLock<IReadOnlyList<Unseated>>(seats =>
    {
        if (!_hasRaced || IsStarted) return [];
        var cutoff = _time.GetUtcNow() - ReadyTimeout;
        var host = HostConnectionId;
        var idle = seats.Values
            .Where(p => !p.IsReady && p.ConnectionId != host
                && _unreadySince.TryGetValue(p.ConnectionId, out var since) && since <= cutoff)
            .ToList();
        foreach (var p in idle) Leave(p.ConnectionId);
        return [.. idle.Select(p => new Unseated(p.ConnectionId, p.DisplayName))];
    });

    /// <summary>
    /// The race grid for <paramref name="roster"/> (the roster the start gate passed): humans in
    /// seat order, then as many AI drivers as asked for and fit.
    /// </summary>
    public IReadOnlyList<PoCabinetDriver> BuildGrid(IReadOnlyList<PoCabinetLobbyPlayer> roster)
    {
        var grid = roster
            .Select(p => new PoCabinetDriver(p.UserId, p.DisplayName, IsPlayer: true,
                Color: string.IsNullOrEmpty(p.Color) ? PoCabinetCatalog.DefaultSeatColor : p.Color, Personality: null))
            .ToList();
        var bots = PoCabinetPersonality.OnlineBots;
        for (int i = 0; i < PoCabinetLobbyRules.BotSeats(BotCount, roster.Count); i++)
        {
            var o = bots[i];
            grid.Add(new PoCabinetDriver($"bot-{i}", o.Name, IsPlayer: false, o.Color, o.Personality,
                o.MaxSpeed, o.CorneringSkill, o.Id));
        }
        return grid;
    }

    /// <summary>The host can begin: every other seat is ready and the grid would hold at least two cars, AI counted (a lone host with bots on can race).</summary>
    protected override bool CanStart(IReadOnlyList<PoCabinetLobbyPlayer> players, string hostConnectionId) =>
        base.CanStart(players, hostConnectionId)
        && players.Count + PoCabinetLobbyRules.BotSeats(_botCount, players.Count) >= 2;

    protected override PoCabinetLobbyPlayer WithReady(PoCabinetLobbyPlayer player, bool ready) =>
        player with { IsReady = ready };

    protected override void OnLeft(string connectionId) => _unreadySince.Remove(connectionId);

    protected override void OnSeatTouched(string connectionId) => _unreadySince[connectionId] = _time.GetUtcNow();

    protected override void OnEnded() => GameCode = GlobalCode;

    private bool HostedIdle(string connectionId) => !IsStarted && HostConnectionId == connectionId;

    /// <summary>Paint names from the paint shop or #rrggbb; anything else becomes empty (client default).</summary>
    private static string SanitizeColor(string? color)
    {
        if (string.IsNullOrWhiteSpace(color) || color.Length > 20) return "";
        return color.All(ch => char.IsAsciiLetterOrDigit(ch) || ch == '#') ? color : "";
    }

    /// <summary>A player whose seat was freed by the ready timeout, and the connection to tell.</summary>
    public sealed record Unseated(string ConnectionId, string DisplayName);
}
