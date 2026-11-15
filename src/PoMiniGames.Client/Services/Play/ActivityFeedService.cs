using PoMiniGamesClient.Models;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Aggregates the player's most recent plays into a single feed for the home
/// page. Sources:
///   • match history (local 2P + online multiplayer, sorted by timestamp)
///   • the high-scores endpoint for solo games (when the API returns a row
///     with a non-zero score, we surface it as "You scored N on PoSnakeGame")
///
/// The feed is best-effort and never throws — a single failed source must
/// not blank the home page. Each item carries an absolute timestamp so the
/// UI can render relative times without re-querying.
/// </summary>
public sealed class ActivityFeedService
{
    private readonly ApiService _api;
    private readonly MatchHistoryService _matchHistory;

    public ActivityFeedService(ApiService api, MatchHistoryService matchHistory)
    {
        _api = api;
        _matchHistory = matchHistory;
    }

    public sealed record FeedItem(
        DateTimeOffset When,
        string Icon,
        string GameKey,
        string GameTitle,
        string Message,
        string? Url);

    public async Task<IReadOnlyList<FeedItem>> GetRecentAsync(int limit = 5)
    {
        var items = new List<FeedItem>();
        try
        {
            var matches = await _matchHistory.GetMyMatchesAsync(limit: 50);
            items.AddRange(matches
                .Where(m => !string.IsNullOrEmpty(m.Game))
                .OrderByDescending(m => m.PlayedAt)
                .Take(limit)
                .Select(m => new FeedItem(
                    When: new DateTimeOffset(DateTime.SpecifyKind(m.PlayedAt, DateTimeKind.Utc), TimeSpan.Zero),
                    Icon: OutcomeIcon(m.Outcome),
                    GameKey: m.Game,
                    GameTitle: GameTitle(m.Game),
                    Message: OutcomeMessage(m),
                    Url: GameUrl(m.Game))));
        }
        catch
        {
            // Swallow — the feed is optional UI sugar, not a blocker.
        }
        return items;
    }

    private static string OutcomeIcon(string outcome) => outcome switch
    {
        "win" => "🏆",
        "loss" => "💔",
        "draw" => "🤝",
        _ => "🎮"
    };

    private static string OutcomeMessage(MatchRecordDto m) => m.Outcome switch
    {
        "win" => $"You beat {m.OpponentName}",
        "loss" => $"{m.OpponentName} beat you",
        "draw" => $"Drew with {m.OpponentName}",
        _ => $"Played {m.OpponentName}"
    };

    private static string GameTitle(string key) => key switch
    {
        "tictactoe" => "Tic-Tac-Toe",
        "connectfive" => "Connect Five",
        "poracer" => "Racer",
        "pocouplequiz" => "Couple Quiz",
        "pofunquiz" => "Fun Quiz",
        _ => key
    };

    private static string GameUrl(string key) => key switch
    {
        "tictactoe" => "/tictactoe",
        "connectfive" => "/connectfive",
        "poracer" => "/poracer",
        "pocouplequiz" => "/couplequiz",
        "pofunquiz" => "/funquiz",
        _ => "/"
    };
}
