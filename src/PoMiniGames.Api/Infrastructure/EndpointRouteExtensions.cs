using PoMiniGames.Features.Account;
using PoMiniGames.Features.Identity;
using PoMiniGames.Features.Shared.TurnMatch; // ConnectFiveHub + TicTacToeHub (shared turn-match hubs)
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.Invites;       // push subscriptions + game invites
using PoMiniGames.Features.PoBrawl;       // 1P ladder, KO board, dossiers, progress
using PoMiniGames.Features.PoBrawl.Online; // lobby hub + match hub + match ingest
using PoMiniGames.Features.PoMarbleRace;  // high scores + the 2-player race hub
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;  // CoupleQuizHub (the slice's only server surface)
using PoMiniGames.Features.PoEcosystem;   // cloud world slots, gallery
using PoMiniGames.Features.PoFighter;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoCapitol;     // after-action report card PNG
using PoMiniGames.Features.PoCabinet;     // score, lobby + race hubs
using PoMiniGames.Features.PoVoxelStrike;
using PoMiniGames.Features.PoMule;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Single, ordered registration point for every HTTP endpoint and SignalR hub.
/// Program.cs maps the whole surface with one <c>app.MapPoMiniGamesEndpoints()</c>
/// call, so the route table is described in exactly one place.
///
/// The authenticated game API is one <c>MapGroup("/api")</c>: the prefix is declared
/// once here and every slice below mounts a relative group under it, so the shared
/// <c>/api</c> segment and the auth gate that guards it are stated in the same place.
/// (Declaring it once keeps the boundary the antiforgery filter keys on visible at the
/// registration site.) Anonymous surfaces below are mapped
/// straight on <c>app</c> and therefore still spell their full path. SignalR hubs are mapped directly on
/// <c>app</c> because <c>MapHub&lt;T&gt;</c> returns <c>IHubEndpointConventionBuilder</c>,
/// which is not an <c>IEndpointConventionBuilder</c> and cannot be composed inside a group.
/// </summary>
internal static class EndpointRouteExtensions
{
    public static WebApplication MapPoMiniGamesEndpoints(this WebApplication app)
    {
        // ── Platform: unprotected (health probes, diagnostics) ──
        // CSRF token issuer.
        app.MapAntiforgeryEndpoints();
        app.MapHealthEndpoints();
        // Uniform cross-app liveness probe (see PoPlatform). Same shape in every Po app, which
        // is what lets the portfolio dashboard poll them all and render one uptime grid.
        app.MapPoLiveness();
        // /api/diag.
        app.MapDiagEndpoints();
        // Browser-side error sink (js/platform/errorReporter.js). Deliberately NOT under /api: it is fed
        // by sendBeacon, which cannot carry the antiforgery header that scope requires.
        app.MapClientErrorEndpoints();

        // ── Public read-only leaderboards ──────────────────────────────────
        // Pure GETs that any visitor can read. Score SUBMIT paths live in the
        // /api group below, where every write needs the antiforgery token.
        app.MapUnifiedLeaderboardEndpoints();
        // PoVoxelStrike voxel assets are read-only game content (content-addressed,
        // immutable), so they sit with the anonymous reads; the run-submission POST
        // is in the /api group below.
        app.MapPoVoxelStrikeAssetEndpoints();
        // PoEcosystem gallery: shared islands are public by their owners' choice, and a visit
        // is a read of bytes only the browser engine can interpret.
        app.MapPoEcosystemGalleryEndpoints();
        // Dynamic SVG Player License cards & Online MMR profile inspection
        app.MapPlayerCardEndpoints();
        // PoBrawl fighter dossiers: public reference text (static facts + a cached Wikipedia
        // summary) that the fighter select shows.
        app.MapPoBrawlDossierEndpoints();

        // ── Game API ──────────────────────────────────────────────────────
        // All game-data endpoints read the player-id/initials identity populated by
        // UsePlayerIdentity(). There is no route-level gate; an endpoint that needs a
        // player id checks for one itself.
        var gameApi = app.MapGroup("/api");

        // Play sessions: minted per game opened, redeemed by the score guard on submission.
        // A session is bound to a player id — there is nothing to bind for a caller without
        // one, and an unbound session is a token anyone could spend.
        gameApi.MapPlaySessionEndpoints();
        // Self-service data export + erase. The subject is always the caller's own player id.
        gameApi.MapAccountEndpoints();
        gameApi.MapGetPlayerStats();
        gameApi.MapSavePlayerStats();
        gameApi.MapMarbleRaceHighScoresEndpoints();
        gameApi.MapPoBrawlLeaderboardEndpoints();
        gameApi.MapPoFighterEloEndpoints();
        // The 1P ladder run per player id.
        gameApi.MapPoBrawlProgressEndpoints();
        gameApi.MapMatchHistoryEndpoints();
        // PoCoupleQuiz is SignalR-first — CoupleQuizHub below is its entire server surface.
        gameApi.MapFunQuizEndpoints();
        gameApi.MapPoRacerScoreEndpoints();
        gameApi.MapPoCabinetScoreEndpoints();
        gameApi.MapPoVoxelStrikeScoreEndpoints();
        gameApi.MapPoMuleScoreEndpoints();
        // PoCapitol after-action report card: stateless, renders a PNG from the posted series.
        gameApi.MapPoCapitolReportCardEndpoints();
        // PoBrawl online (lobby + match hub) — match result ingest endpoint. Same
        // shape as PoRacer's score endpoints: rate-limited highscores.
        gameApi.MapPoBrawlOnlineMatchEndpoints();
        // PoEcosystem: the caller's three cloud slots and sharing.
        gameApi.MapPoEcosystemEndpoints();
        // Game invites: push subscriptions, invite-a-past-opponent and the lobby QR code.
        gameApi.MapInviteEndpoints();

        // ── SignalR hubs (identity from the playerId/initials query) ──────
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game");
        app.MapHub<FunQuizHub>("/funquiz/gamehub");
        app.MapHub<FunQuizLobbyHub>("/funquiz/lobby-hub");
        app.MapHub<CoupleQuizLobbyHub>("/couplequiz/lobby-hub");
        app.MapHub<PoRacerLobbyHub>("/poracer/lobby-hub");
        app.MapHub<PoRacerRaceHub>("/poracer/race-hub");
        app.MapHub<PoCabinetLobbyHub>("/pocabinet/lobby-hub");
        app.MapHub<PoCabinetRaceHub>("/pocabinet/race-hub");
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyHub>("/povoxelstrike/lobby-hub");
        app.MapHub<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepHub>("/povoxelstrike/lockstep-hub");
        app.MapHub<PoBrawlLobbyHub>("/pobrawl/lobby-hub");
        app.MapHub<PoBrawlMatchHub>("/pobrawl/match-hub");
        app.MapHub<ConnectFiveHub>("/connectfive/hub");
        app.MapHub<TicTacToeHub>("/tictactoe/hub");
        app.MapHub<ConnectFiveLobbyHub>("/connectfive/lobby-hub");
        app.MapHub<TicTacToeLobbyHub>("/tictactoe/lobby-hub");
        app.MapHub<PoMarbleRaceOnlineHub>("/pomarblerace/hub");
        app.MapHub<PoMarbleRaceLobbyHub>("/pomarblerace/lobby-hub");

        return app;
    }
}
