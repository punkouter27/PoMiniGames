namespace PoMiniGamesClient.Models;

/// <summary>Payload sent to /api/matches when a head-to-head match finishes.</summary>
public sealed class MatchRecordRequest
{
    public string Owner { get; set; } = "";
    public string Game { get; set; } = "";
    /// <summary>"local-2p" or "multiplayer".</summary>
    public string Mode { get; set; } = "multiplayer";
    public string OpponentName { get; set; } = "";
    /// <summary>"guest" or "microsoft".</summary>
    public string? OpponentType { get; set; }
    /// <summary>"win", "loss", or "draw" from the owner's perspective.</summary>
    public string Outcome { get; set; } = "draw";
    public string? OwnerType { get; set; }
}

/// <summary>A single recorded match returned from /api/matches.</summary>
public sealed class MatchRecordDto
{
    public string Game { get; set; } = "";
    public string Mode { get; set; } = "";
    public string OpponentName { get; set; } = "";
    public string OpponentType { get; set; } = "guest";
    public string Outcome { get; set; } = "";
    public DateTime PlayedAt { get; set; }
}
