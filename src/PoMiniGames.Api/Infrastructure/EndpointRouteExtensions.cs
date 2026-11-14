using PoMiniGames.Features.Account;
using PoMiniGames.Features.Auth;
using PoMiniGames.Features.Shared.TurnMatch; // ConnectFiveHub + TicTacToeHub (shared turn-match hubs)
using PoMiniGames.Features.Health;
using PoMiniGames.Features.Integrity;
using PoMiniGames.Features.Invites;       // push subscriptions + game invites (2026-10-01)
using PoMiniGames.Features.PoBrawl;        // moved out of Features.HighScores 2026-08-11,
                                           // same correction PoMarbleRace already had
using PoMiniGames.Features.PoBrawl.Online; // 2026-09-14: lobby hub + match hub + match ingest
using PoMiniGames.Features.PoMarbleRace;   // moved out of Features.HighScores so the
                                           // namespace matches its own slice folder
using PoMiniGames.Features.Leaderboard;
using PoMiniGames.Features.MatchHistory;
using PoMiniGames.Features.PoCoupleQuiz;  // CoupleQuizHub (the slice's only server surface)
using PoMiniGames.Features.PoEcosystem;   // cloud world slots, gallery (2026-09-14)
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoRacer;
using PoMiniGames.Features.PoCabinet; // T4-T6: career, score, lobby + race hubs
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
        // Browser-side error sink (js/errorReporter.js). Deliberately NOT under /api: it is fed
        // by sendBeacon, which cannot carry the antiforgery header that scope requires.
        app.MapClientErrorEndpoints();

        // ── Public read-only leaderboards (guest-first) ────────────────────
        // A brand-new visitor can browse the boards before signing in, so
        // the leaderboard READ endpoints are anonymous. These are pure GETs
        // (no writes), and default authorization is anonymous — they just have to
        // stay outside the authenticated group below. Score
        // SUBMIT paths stay authenticated (guests park scores locally and flush
        // them on sign-in), so anonymous read never becomes anonymous write.
        app.MapUnifiedLeaderboardEndpoints();
        // PoVoxelStrike voxel assets are read-only game content (content-addressed,
        // immutable), so they sit with the anonymous reads; the run-submission POST
        // is in the authenticated group below.
        app.MapPoVoxelStrikeAssetEndpoints();
        // PoEcosystem gallery: shared islands are public by their owners' choice, and a visit
        // is a read of bytes only the browser engine can interpret.
        app.MapPoEcosystemGalleryEndpoints();
        // Dynamic SVG Player License cards & Online MMR profile inspection
        app.MapPlayerCardEndpoints();
        // PoBrawl fighter dossiers: public reference text (static facts + a cached Wikipedia
        // summary) that the fighter select shows before sign-in.
        app.MapPoBrawlDossierEndpoints();

        // ── Game API ──────────────────────────────────────────────────────
        // All game-data endpoints use the lightweight player-initials identity
        // populated by UsePlayerIdentity() — no OAuth gate required.
        var gameApi = app.MapGroup("/api");

        // Play sessions: minted per game opened, redeemed by the score guard on submission.
        // Authenticated because a session is bound to an identity — there is nothing to bind
        // for an anonymous caller, and an unbound session is a token anyone could spend.
        gameApi.MapPlaySessionEndpoints();
        // Self-service data export + erase. In the authenticated group for the obvious reason:
        // the subject is always the caller's own claim identity.
        gameApi.MapAccountEndpoints();
        gameApi.MapGetPlayerStats();
        gameApi.MapSavePlayerStats();
        gameApi.MapMarbleRaceHighScoresEndpoints();
        gameApi.MapPoBrawlLeaderboardEndpoints();
        // The 1P ladder run per claim identity, so it follows a player across devices.
        gameApi.MapPoBrawlProgressEndpoints();
        gameApi.MapMatchHistoryEndpoints();
        // PoCoupleQuiz is SignalR-first — CoupleQuizHub below is its entire server surface.
        gameApi.MapFunQuizEndpoints();
        gameApi.MapPoRacerScoreEndpoints();
        gameApi.MapPoCabinetScoreEndpoints();
        gameApi.MapPoVoxelStrikeScoreEndpoints();
        gameApi.MapPoMuleScoreEndpoints();
        // PoBrawl online (lobby + match hub) — match result ingest endpoint. Same
        // shape as PoRacer's score endpoints: authenticated, rate-limited highscores.
        gameApi.MapPoBrawlOnlineMatchEndpoints();
        // PoEcosystem: the caller's three cloud slots and sharing.
        gameApi.MapPoEcosystemEndpoints();
        // Game invites: push subscriptions, invite-a-past-opponent and the lobby QR code.
        gameApi.MapInviteEndpoints();

        // ── SignalR hubs (no OAuth gate; identity from playerId/initials) ─
        app.MapHub<CoupleQuizHub>("/couplequiz/hubs/game");
        app.MapHub<FunQuizHub>("/funquiz/gamehub");
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
        app.MapHub<PoMarbleRaceOnlineHub>("/pomarblerace/hub");

        return app;
    }
}
