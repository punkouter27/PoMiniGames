using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.SignalR.Client;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Features.PoCoupleQuiz.Services;

/// <summary>
/// Strongly-typed mirror of the PoCoupleQuiz server contracts. Lives in the client
/// project so the WASM doesn't depend on the host's types. Field shapes match the
/// server payloads exactly (camelCase via JSON).
/// </summary>
/// <remarks>
/// The payloads carry no game code: the lobby (its own hub, see <c>OnlineLobby</c>) pairs the
/// players and hands both an internal match code, which <see cref="JoinMatchAsync"/> claims a seat with.
/// </remarks>
public record CoupleQuizGamePlayerState(string Name, bool IsKingPlayer, int Score);

public record CoupleQuizGameStartedPayload(
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundIndex,
    int MaxRounds,
    int RoundSeconds);

public record CoupleQuizRoundStartedPayload(
    int RoundIndex,
    int MaxRounds,
    string KingPlayerName,
    List<CoupleQuizGamePlayerState> Players,
    string QuestionText,
    string QuestionCategory,
    int RoundSeconds);

public record CoupleQuizAnswerRecordedPayload(string PlayerName, int RoundIndex);

public record CoupleQuizRoundResultPayload(
    int RoundIndex,
    string KingAnswer,
    List<string> MatchedPlayers,
    Dictionary<string, int> Scores,
    Dictionary<string, string> PlayerAnswers,
    List<CoupleQuizGamePlayerState> Players);

public record CoupleQuizGameOverPayload(
    IReadOnlyDictionary<string, int> FinalScores,
    List<CoupleQuizGamePlayerState> Players);

/// <summary>The lobby hand-off to the game page: the internal match code and this player seat name.</summary>
public sealed record CoupleQuizPendingMatch(string MatchCode, string PlayerName);

/// <summary>
/// Client-side wrapper around the <c>/couplequiz/hubs/game</c> SignalR connection.
/// Exposes the server events as C# events for the page to subscribe to. The page
/// should call <see cref="ConnectAsync"/> on init, then <see cref="JoinMatchAsync"/>
/// with the code the lobby handed over (<see cref="PendingMatch"/>).
/// </summary>
public sealed class CoupleQuizHubService : IAsyncDisposable
{
    private readonly NavigationManager _navigation;
    private readonly ApiEndpoints _endpoints;
    private HubConnection? _connection;

    /// <summary>The match the lobby reserved, waiting for the game page to claim its seat.</summary>
    public CoupleQuizPendingMatch? PendingMatch { get; set; }

    /// <summary>Take (and clear) the pending match, so a refresh of the game page cannot rejoin a stale one.</summary>
    public CoupleQuizPendingMatch? TakePendingMatch()
    {
        var pending = PendingMatch;
        PendingMatch = null;
        return pending;
    }

    public event Action<CoupleQuizGameStartedPayload>? OnGameStarted;
    public event Action<CoupleQuizRoundStartedPayload>? OnRoundStarted;
    public event Action<CoupleQuizAnswerRecordedPayload>? OnAnswerRecorded;
    public event Action<CoupleQuizRoundResultPayload>? OnRoundResult;
    public event Action<CoupleQuizGameOverPayload>? OnGameOver;
    public event Action<string>? OnGameError;
    public event Action<HubConnectionState>? ConnectionChanged;

    public CoupleQuizHubService(NavigationManager navigation, ApiEndpoints endpoints) =>
        (_navigation, _endpoints) = (navigation, endpoints);

    public HubConnectionState ConnectionState => _connection?.State ?? HubConnectionState.Disconnected;

    public async Task ConnectAsync()
    {
        if (_connection is { } current)
        {
            if (current.State != HubConnectionState.Disconnected) return;
            await current.StartAsync();
            ConnectionChanged?.Invoke(current.State);
            return;
        }
        // Absolute URL: SignalR ignores the DI HttpClient BaseAddress, so we
        // compose against ApiEndpoints.ApiBase — the API host (:5000), not the
        // WASM host (:5261). Without this, the standalone client hits
        // /couplequiz/hubs/game/negotiate on :5261 and gets a 405.
        // Credentials handler + auto-reconnect come baked into the shared
        // factory (see HubConnectionFactory for the cookie contract).
        _connection = HubConnectionFactory.Create(_endpoints.Hub("couplequiz/hubs/game"));

        _connection.On<CoupleQuizGameStartedPayload>("GameStarted", p => OnGameStarted?.Invoke(p));
        _connection.On<CoupleQuizRoundStartedPayload>("RoundStarted", p => OnRoundStarted?.Invoke(p));
        _connection.On<CoupleQuizAnswerRecordedPayload>("AnswerRecorded", p => OnAnswerRecorded?.Invoke(p));
        _connection.On<CoupleQuizRoundResultPayload>("RoundResult", p => OnRoundResult?.Invoke(p));
        _connection.On<CoupleQuizGameOverPayload>("GameOver", p => OnGameOver?.Invoke(p));
        _connection.On<string>("GameError", m => OnGameError?.Invoke(m));

        _connection.Reconnecting += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Reconnecting);
            return Task.CompletedTask;
        };
        // No re-join: the server dropped the seat with the old connection, and a match cannot resume.
        _connection.Closed += _ =>
        {
            ConnectionChanged?.Invoke(HubConnectionState.Disconnected);
            return Task.CompletedTask;
        };

        await _connection.StartAsync();
        ConnectionChanged?.Invoke(_connection.State);
    }

    /// <summary>Claim the seat the lobby reserved, by the internal match code.</summary>
    public Task JoinMatchAsync(string matchCode, string playerName)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("JoinMatch", matchCode, playerName);
    }

    public Task SubmitAnswerAsync(string answer)
    {
        EnsureConnected();
        return _connection!.InvokeAsync("SubmitAnswer", answer);
    }

    private void EnsureConnected()
    {
        if (_connection is null || _connection.State != HubConnectionState.Connected)
        {
            throw new InvalidOperationException("Hub connection is not active. Call ConnectAsync first.");
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (_connection is not null)
        {
            await _connection.DisposeAsync();
        }
    }
}
