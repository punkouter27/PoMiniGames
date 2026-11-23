namespace PoMiniGames.Shared.Games;

// ─────────────────────  Quiz lobbies (Fun Quiz, Couple Quiz)  ─────────────────────
//
// Each quiz has its own shared ready/start lobby (LobbyHub), capped at two. The host's picks
// ride on every seat of the lobby state, so the guest reads them off the host's seat with no
// extra message; a new seat starts on the room's last pick.

/// <summary>A Fun Quiz seat. <see cref="Category"/> is the wire name of the question category.</summary>
public sealed record FunQuizLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    string Category,
    int QuestionCount) : ILobbyPlayer;

/// <summary>A Couple Quiz seat. <see cref="TopicPack"/> is the normalised topic id (Everything or a question-bank category).</summary>
public sealed record CoupleQuizLobbyPlayer(
    string ConnectionId,
    string DisplayName,
    bool IsGuest,
    bool IsReady,
    int Rounds,
    string TopicPack) : ILobbyPlayer;
