using System.Net;
using System.Net.Http.Json;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Routing;
using PoMiniGamesClient.Models;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Mints a play session whenever the player opens a game, so their score submissions can be
/// checked against a start time the server itself recorded.
/// </summary>
/// <remarks>
/// <para>
/// <b>Driven by navigation, not by the games.</b> Sixteen pages render a game and every one of
/// them would otherwise need to remember to start a session — and a game that forgot would look
/// identical to a cheater to the server-side guard. Instead this listens to
/// <see cref="NavigationManager.LocationChanged"/> and resolves the route against
/// <see cref="GameCatalog.All"/>, which already declares every game's every mode URL. A game
/// cannot be missing from that catalogue without also being missing from the home page, so the
/// coverage is structural rather than remembered.
/// </para>
/// <para>
/// <b>Failure is silent and non-blocking on purpose.</b> A caller without a player id gets a 401
/// here, the server is configured Off in some deployments (204), and the whole endpoint is
/// unreachable offline. None of those may cost the player their round, so every failure path
/// ends the same way: no session is held, the submission goes out bare, and the server — in its
/// default Observe mode — logs it and saves the score anyway.
/// </para>
/// </remarks>
public sealed class PlaySessionService : IDisposable
{
    /// <summary>
    /// How long to stay quiet after a failed mint. Without it, a signed-out player browsing the
    /// game grid fires a 401 on every card they open.
    /// </summary>
    private static readonly TimeSpan FailureBackoff = TimeSpan.FromMinutes(2);

    /// <summary>
    /// Re-mint once a session is this close to expiring, rather than carrying a token that will
    /// be refused the moment the round ends.
    /// </summary>
    private static readonly TimeSpan RenewalMargin = TimeSpan.FromMinutes(5);

    private readonly HttpClient _http;
    private readonly NavigationManager _navigation;
    private readonly PlaySessionStore _store;
    private readonly ILogger<PlaySessionService> _log;

    private DateTimeOffset _quietUntil = DateTimeOffset.MinValue;
    private bool _started;

    /// <summary>
    /// Game-route prefixes, longest first. Built once from the catalogue so "/game/lobby"
    /// resolves to that game via the "/game" prefix even though no mode declares that exact
    /// URL — a game's own sub-routes belong to that game.
    /// </summary>
    private static readonly (string Prefix, string GameKey)[] RoutePrefixes = BuildRoutePrefixes();

    public PlaySessionService(
        HttpClient http,
        NavigationManager navigation,
        PlaySessionStore store,
        ILogger<PlaySessionService> log)
    {
        _http = http;
        _navigation = navigation;
        _store = store;
        _log = log;
    }

    /// <summary>
    /// Starts listening and mints for the page the app booted on. Called once from MainLayout —
    /// idempotent, because a second subscription would double every mint.
    /// </summary>
    public async Task InitializeAsync()
    {
        if (_started)
        {
            return;
        }

        _started = true;
        _navigation.LocationChanged += OnLocationChanged;
        await SyncAsync(_navigation.Uri);
    }

    public void Dispose()
    {
        if (_started)
        {
            _navigation.LocationChanged -= OnLocationChanged;
            _started = false;
        }
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e) =>
        _ = SyncAsync(e.Location);

    /// <summary>
    /// Brings the held session in line with the route now showing: mint for a game route, drop
    /// the session on a non-game route.
    /// </summary>
    private async Task SyncAsync(string uri)
    {
        var game = ResolveGameKey(uri);
        if (game is null)
        {
            // Off a game route: hold nothing. A submission fired from here (an offline replay
            // flushing on the home page) then carries no session, which is honest — rather than
            // a session for a game it did not come from, which would read as forgery.
            _store.Clear();
            return;
        }

        if (string.Equals(_store.GameKey, game, StringComparison.OrdinalIgnoreCase)
            && _store.IsLive
            && DateTimeOffset.UtcNow + RenewalMargin < _store.ExpiresAtUtc)
        {
            return;
        }

        if (DateTimeOffset.UtcNow < _quietUntil)
        {
            return;
        }

        await MintAsync(game);
    }

    private async Task MintAsync(string game)
    {
        try
        {
            using var response = await _http.PostAsync($"/api/play/sessions/{game}", content: null);

            // 204 means the server runs with integrity off — there is no session to hold and no
            // point asking again this session.
            if (response.StatusCode == HttpStatusCode.NoContent)
            {
                _store.Clear();
                _quietUntil = DateTimeOffset.UtcNow.AddHours(1);
                return;
            }

            if (!response.IsSuccessStatusCode)
            {
                // 401 for a signed-out visitor is the common and entirely expected case, so this
                // stays at Debug: logging it louder would fill the console on the game grid.
                _log.LogDebug("Play session mint returned {Status} for {Game}", (int)response.StatusCode, game);
                _store.Clear();
                _quietUntil = DateTimeOffset.UtcNow + FailureBackoff;
                return;
            }

            var ticket = await response.Content.ReadFromJsonAsync(ApiJsonContext.Default.PlaySessionTicketDto);
            if (ticket is null || string.IsNullOrEmpty(ticket.Token))
            {
                _store.Clear();
                _quietUntil = DateTimeOffset.UtcNow + FailureBackoff;
                return;
            }

            _store.Set(game, ticket.Token, ticket.ExpiresAtUtc);
            _quietUntil = DateTimeOffset.MinValue;
        }
        catch (Exception ex)
        {
            // Offline, DNS failure, a torn-down circuit mid-navigation. The round must still be
            // playable and its score must still be submittable, so this can never propagate.
            _log.LogDebug(ex, "Play session mint failed for {Game}", game);
            _store.Clear();
            _quietUntil = DateTimeOffset.UtcNow + FailureBackoff;
        }
    }

    /// <summary>
    /// Maps a location to a game key, or null when the route is not a game.
    /// </summary>
    internal static string? ResolveGameKey(string uri)
    {
        var path = ExtractPath(uri);
        if (path.Length <= 1)
        {
            return null;
        }

        foreach (var (prefix, game) in RoutePrefixes)
        {
            // Segment-aware: "/poracer" must match "/poracer/lobby" but not a hypothetical
            // "/poracerstats", which is a different route that happens to share a prefix.
            if (path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
                && (path.Length == prefix.Length || path[prefix.Length] == '/'))
            {
                return game;
            }
        }

        return null;
    }

    /// <summary>Absolute or relative URI to a leading-slash path, without query or fragment.</summary>
    private static string ExtractPath(string uri)
    {
        var path = Uri.TryCreate(uri, UriKind.Absolute, out var absolute)
            ? absolute.AbsolutePath
            : uri;

        var cut = path.IndexOfAny(['?', '#']);
        if (cut >= 0)
        {
            path = path[..cut];
        }

        if (!path.StartsWith('/'))
        {
            path = "/" + path;
        }

        return path.Length > 1 ? path.TrimEnd('/') : path;
    }

    /// <summary>
    /// Reduces every catalogue URL to its first path segment and pairs it with the owning game.
    /// Longest first so a future nested route ("/pobrawl/demo") still wins over its own root if
    /// the two ever map to different keys.
    /// </summary>
    private static (string, string)[] BuildRoutePrefixes()
    {
        var prefixes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        foreach (var game in GameCatalog.All)
        {
            foreach (var mode in game.Modes)
            {
                foreach (var url in new[] { mode.Url, mode.ChipUrl })
                {
                    if (string.IsNullOrWhiteSpace(url))
                    {
                        continue;
                    }

                    var path = ExtractPath(url!);
                    var segmentEnd = path.IndexOf('/', 1);
                    var root = segmentEnd > 0 ? path[..segmentEnd] : path;
                    if (root.Length > 1)
                    {
                        prefixes[root] = game.Key.Value;
                    }
                }
            }
        }

        return prefixes
            .OrderByDescending(kv => kv.Key.Length)
            .Select(kv => (kv.Key, kv.Value))
            .ToArray();
    }
}
