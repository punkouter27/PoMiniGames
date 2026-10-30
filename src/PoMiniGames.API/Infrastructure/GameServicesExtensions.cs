using PoMiniGames.Features.Integrity;
using PoMiniGames.Domain.Services;
using PoMiniGames.Features.PoCoupleQuiz;
using PoMiniGames.Features.PoFunQuiz;
using PoMiniGames.Features.PoFunQuiz.Storage;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Features.PoJevArena;
using PoMiniGames.Features.PoJevArena.Jev;
using PoMiniGames.Features.PoRacer;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Options;
using PoMiniGames.Infrastructure.Services;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// Registers all game-specific services used by the local-only app.
/// </summary>
internal static class GameServicesExtensions
{
    public static IServiceCollection AddPoMiniGamesGameServices(this IServiceCollection services)
    {
        // ─── Score integrity + account data ─────────────────────────────────
        // The guard is what stands between a public leaderboard and a client that can post any
        // number it likes. Registered here rather than in its slice so the options binding,
        // the session minter and the guard itself cannot be wired up half-way — a guard with
        // no PlaySessionService behind it silently degrades to range checks only.
        services.AddOptions<PoMiniGames.Features.Integrity.IntegrityOptions>()
            .BindConfiguration(PoMiniGames.Features.Integrity.IntegrityOptions.SectionName);
        // TryAdd: TimeProvider.System is the default the framework registers in most hosts, but
        // not all of them, and PlaySessionService's elapsed measurement is the whole mechanism.
        services.TryAddSingleton(TimeProvider.System);
        services.AddSingleton<PoMiniGames.Features.Integrity.PlaySessionService>();
        services.AddSingleton<PoMiniGames.Features.Integrity.ScoreIntegrityGuard>();
        // Scoped: one cross-table scan per request, and it holds no state between them.
        services.AddScoped<PoMiniGames.Features.Account.PlayerDataService>();

        // Elo calculation, on the defaults in EloOptions.
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<IOptions<EloOptions>>();
            return new EloCalculator(config.Value);
        });
        // Head-to-head ratings for the PoBrawl demo board. A distinct calculator with its own
        // options section, not a mode of EloCalculator — see PairwiseEloCalculator's remarks
        // for why the two cannot merge.
        // BindConfiguration rather than Configure(section): this extension takes no
        // IConfiguration, and resolving it from DI keeps the signature unchanged.
        services.AddOptions<PairwiseEloOptions>().BindConfiguration(PairwiseEloOptions.SectionName);
        services.AddSingleton(sp =>
        {
            var config = sp.GetRequiredService<IOptions<PairwiseEloOptions>>();
            return new PairwiseEloCalculator(config.Value);
        });

        // Storage initializer for the consolidated games (PoCoupleQuiz, PoFunQuiz).
        // Ensures all per-game tables and blob containers exist at host startup.
        services.AddSingleton<StorageInitializer>();

        // MatchHistory — cross-game head-to-head record (local 2P + online multiplayer).
        // Writes to the MatchHistory table (PartitionKey = owner identity, RowKey = reverse-time).
        services.AddSingleton<PoMiniGames.Features.MatchHistory.MatchHistoryRepository>();

        // Server-timed race results (PoRacer, PoCabinet multiplayer), written through to Table
        // Storage so the proof behind a parked score survives an F1 recycle.
        services.AddSingleton<VerifiedResultStore>();

        // Game invites: subscriptions, pending invites and the self-provisioned VAPID key in one
        // table, plus the sender. Redirects are off because the sender POSTs to an address a
        // subscriber supplied; it is host-checked, and a redirect would walk past that check.
        services.AddSingleton<PoMiniGames.Features.Invites.InviteStore>();
        services.AddHttpClient<PoMiniGames.Features.Invites.WebPushSender>(client => client.Timeout = TimeSpan.FromSeconds(10))
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler { AllowAutoRedirect = false });

        // Fail-fast startup validator: throws in Production when fake auth is on.
        services.AddHostedService<StartupSecretValidator>();

        // PoCoupleQuiz — see Features/PoCoupleQuiz/. Questions are dealt from the embedded
        // JSON bank (CoupleQuizQuestionBank). CoupleQuizOptions is bound in Program.cs before
        // AddPoMiniGamesGameServices.
        services.AddSingleton<GameSessionManager>();
        // Note: GameSessionManager is a pure in-memory state holder, not a hosted service.
        // The round timer lives in CoupleQuizRoundDirector below.
        // Owns the round clock. A Hub instance lives for one invocation and cannot hold a
        // timer, so rounds are driven from this singleton over a long-lived IHubContext.
        services.AddSingleton<CoupleQuizRoundDirector>();

        // PoFunQuiz — Phase 2 of the consolidation. See Features/PoFunQuiz/.
        // Questions are dealt at random from the embedded JSON bank (FunQuizQuestionService).
        // The leaderboard repository writes to the
        // PoFunQuizPlayers table (PartitionKey = Category, RowKey = Guid).
        // MultiplayerLobbyService is the in-memory registry for the SignalR hub
        // (CreateGame/JoinGame/StartGame/UpdateScore/PlayerFinished).
        services.AddSingleton<IFunQuizQuestionSource, FunQuizQuestionService>();
        services.AddSingleton<PoMiniGames.Features.PoFunQuiz.Storage.LeaderboardRepository>();
        services.AddSingleton<MultiplayerLobbyService>();

        // PoEcosystem — cloud world slots + gallery (blob + table). The store degrades to
        // empty when storage is unreachable.
        services.AddSingleton<EcosystemWorldStore>();

        // PoJevArena — the free rule-based LocalJevClient is the only brain, so the arena always
        // plays. The scripted stub is selected only under the Test environment.
        services.AddOptions<JevOptions>()
            .BindConfiguration(JevOptions.SectionName);
        services.AddSingleton<StubJevClient>();
        services.AddSingleton<LocalJevClient>();
        services.AddTransient<IJevClient>(sp =>
        {
            var options = sp.GetRequiredService<IOptions<JevOptions>>().Value;
            return options.UseStub && sp.GetRequiredService<IHostEnvironment>().IsEnvironment("Test")
                ? sp.GetRequiredService<StubJevClient>()
                : sp.GetRequiredService<LocalJevClient>();
        });
        services.AddSingleton<ArenaMatchRegistry>();
        services.AddSingleton<CreatureLibraryStore>();

        // PoRacer — multiplayer racing. The lobby service is the in-memory
        // registry; the race registry + service own the per-game simulation
        // timer. Both are process-local (single-instance, like every other
        // multiplayer lobby in the host) and are DI-managed so the host's
        // graceful-shutdown path can dispose the race registry.
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoRacer.PoRacerRaceRegistry>();

        // PoCabinet (T6): lobby + race registry, same shape as PoRacer. The registry
        // owns the 30 Hz simulation timer and the per-game SimSession pool, and is
        // disposed via its IAsyncDisposable on host shutdown so the timer doesn't leak.
        services.AddSingleton<PoMiniGames.Features.PoCabinet.PoCabinetLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoCabinet.PoCabinetRaceRegistry>();

        // PoBrawl online — 1v1 SignalR-driven combat. One shared in-memory lobby (the first two
        // arrivals fight), an in-memory match per started fight, and a hosted pump driving the
        // per-tick frame broadcast for all of them.
        services.AddSingleton<PoMiniGames.Features.PoBrawl.Online.PoBrawlLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoBrawl.Online.PoBrawlMatchRegistry>();
        services.AddHostedService<PoMiniGames.Features.PoBrawl.Online.PoBrawlMatchPump>();
        services.AddSingleton<PoMiniGames.Features.PoBrawl.PoBrawlProgressStore>();
        services.AddSingleton<PoMiniGames.Features.PoBrawl.PoBrawlDemoEloGate>();

        // PoBrawl fighter dossiers — static facts enriched once a day from the free Wikimedia
        // REST API. Wikimedia asks for a descriptive User-Agent; the standard resilience handler
        // retries a blip, and short timeouts keep a slow Wikipedia from holding the request
        // (the service falls back to static text on any failure).
        services.AddMemoryCache();
        services.AddOptions<PoMiniGames.Features.PoBrawl.PoBrawlDossierOptions>()
            .BindConfiguration(PoMiniGames.Features.PoBrawl.PoBrawlDossierOptions.SectionName);
        services.AddHttpClient(PoMiniGames.Features.PoBrawl.PoBrawlDossierService.HttpClientName, client =>
            {
                client.BaseAddress = new Uri("https://en.wikipedia.org/api/rest_v1/");
                client.Timeout = TimeSpan.FromSeconds(15);
                client.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", PoMiniGames.Features.PoBrawl.PoBrawlDossierService.UserAgent);
                client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
            })
            .AddStandardResilienceHandler(options =>
            {
                // One 4 s attempt per title, in practice: a retry only fits inside the 5 s total
                // after a fast failure. The page never waits on these anyway (FirstLoadWait).
                options.AttemptTimeout.Timeout = TimeSpan.FromSeconds(4);
                options.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(5);
                options.Retry.MaxRetryAttempts = 1;
            });
        services.AddSingleton<PoMiniGames.Features.PoBrawl.PoBrawlDossierService>();

        // ConnectFive + TicTacToe online — turn-based 1v1 over SignalR. One shared
        // TurnMatchService<THub> per hub holds that game's quick-match queue and every
        // authoritative board; there is no lobby service because a two-seat turn game
        // has nothing to configure before play. The rules instance is the only thing
        // that differs. See Features/Shared/TurnMatch for the reconnect contract.
        services.AddSingleton(sp => new PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.ConnectFive.ConnectFiveHub>(
            PoMiniGames.Shared.Games.ConnectFiveRules.Instance,
            sp.GetRequiredService<Microsoft.AspNetCore.SignalR.IHubContext<PoMiniGames.Features.ConnectFive.ConnectFiveHub>>(),
            sp.GetRequiredService<ILogger<PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.ConnectFive.ConnectFiveHub>>>()));
        services.AddSingleton(sp => new PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.TicTacToe.TicTacToeHub>(
            PoMiniGames.Shared.Games.TicTacToeRules.Instance,
            sp.GetRequiredService<Microsoft.AspNetCore.SignalR.IHubContext<PoMiniGames.Features.TicTacToe.TicTacToeHub>>(),
            sp.GetRequiredService<ILogger<PoMiniGames.Features.Shared.TurnMatch.TurnMatchService<PoMiniGames.Features.TicTacToe.TicTacToeHub>>>()));

        // PoMarbleRace online — host-authoritative 2-player race. The service is only a
        // pairing registry and relay table: the host BROWSER is the simulation (see
        // Shared/Games/PoMarbleRaceShared.cs for why lockstep was not an option).
        services.AddSingleton<PoMiniGames.Features.PoMarbleRace.PoMarbleRaceOnlineService>();

        // PoVoxelStrike — startup GLB → voxel ingestion plus the in-memory asset catalog
        // the manifest/payload endpoints read. See Features/PoVoxelStrike/.
        services.AddOptions<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions>()
            .BindConfiguration(PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeOptions.SectionName);
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.VoxelAssetCatalog>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.AssetIngestionHostedService>();
        // PoVoxelStrike co-op: same single-lobby process-local shape as PoRacer/PoFunQuiz.
        // The lobby service is the in-memory registry; the lockstep service owns the
        // per-game input batching; the pump broadcasts frames on a drift-corrected
        // 50 ms timer (host-independent — survives host websocket reconnects).
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLobbyService>();
        services.AddSingleton<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepService>();
        services.AddHostedService<PoMiniGames.Features.PoVoxelStrike.PoVoxelStrikeLockstepPump>();

        services.ConfigureHttpJsonOptions(options =>
        {
            options.SerializerOptions.Converters.Add(
                new System.Text.Json.Serialization.JsonStringEnumConverter());
        });

        return services;
    }
}
