using PoMiniGamesClient.Models;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Records and reads the local player's head-to-head match results (local 2P and
/// online multiplayer). The "owner" identity is the player's initials when
/// available, otherwise the guest display name — so both authenticated and guest
/// players build up a personal opponent record on the server.
/// </summary>
public sealed class MatchHistoryService
{
    private readonly ApiService _api;
    private readonly PlayerNameService _playerName;

    public MatchHistoryService(ApiService api, PlayerNameService playerName)
    {
        _api = api;
        _playerName = playerName;
    }

    /// <summary>The current player's owner key + type used to scope their match history.</summary>
    public (string Owner, string OwnerType) ResolveOwner()
    {
        // The owner types are stored labels from when the app had sign-in: "microsoft" now
        // means "a player who entered initials" and "guest" one who skipped the prompt. Kept
        // as they are so rows already in storage keep matching their owner.
        var initials = _playerName.Initials;
        return string.IsNullOrWhiteSpace(initials) ? ("Player", "guest") : (initials.Trim(), "microsoft");
    }

    /// <summary>The display label for the current player (what opponents would see).</summary>
    public string MyDisplayName() => ResolveOwner().Owner;

    /// <summary>
    /// Records one finished head-to-head result. Best-effort: never throws, so a
    /// game's end-of-match flow is unaffected when the backend is unreachable.
    /// </summary>
    public async Task RecordAsync(string game, MatchMode mode, string opponentName, MatchOutcome outcome, string? opponentType = null)
    {
        if (string.IsNullOrWhiteSpace(opponentName)) return;

        var (owner, ownerType) = ResolveOwner();
        // Don't record a match against yourself (can happen when scores tie names in a lobby).
        if (string.Equals(owner, opponentName, StringComparison.OrdinalIgnoreCase)) return;

        await _api.RecordMatchAsync(new MatchRecordRequest
        {
            Owner = owner,
            OwnerType = ownerType,
            Game = game,
            Mode = mode == MatchMode.Local2P ? "local-2p" : "multiplayer",
            OpponentName = opponentName.Trim(),
            OpponentType = opponentType ?? (opponentName.Contains('@') ? "microsoft" : "guest"),
            Outcome = outcome switch
            {
                MatchOutcome.Win => "win",
                MatchOutcome.Loss => "loss",
                _ => "draw"
            }
        });
    }

    public async Task<MatchRecordDto[]> GetMyMatchesAsync(int limit = 500)
    {
        var (owner, _) = ResolveOwner();
        return await _api.GetMatchesAsync(owner, limit) ?? [];
    }
}

public enum MatchMode { Local2P, Multiplayer }

public enum MatchOutcome { Win, Loss, Draw }
