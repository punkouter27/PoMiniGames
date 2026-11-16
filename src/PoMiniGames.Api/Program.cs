using FluentValidation;
using PoMiniGames.Features.Identity;
using PoMiniGames.Domain.Abstractions;
using PoMiniGames.Infrastructure;
using PoMiniGames.Infrastructure.Services;
// Note: the full endpoint/hub route table is registered via app.MapPoMiniGamesEndpoints()
// (EndpointRouteExtensions); per-slice types there are referenced in that file, not here.
using Microsoft.AspNetCore.SignalR;   // HubOptions.AddFilter<HubLogContextFilter>()
using Scalar.AspNetCore;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

// ─── Static web assets in Test ───────────────────────────────────────
// ASP.NET auto-loads the static-web-assets manifest (which maps the referenced
// Blazor Client's index.html/_framework into the served file set) ONLY in the
// Development environment. The E2E-UI tier boots the host under "Test", where
// UseBlazorFrameworkFiles/MapFallbackToFile would otherwise 404 on every page.
if (builder.Environment.IsEnvironment("Test"))
{
    builder.WebHost.UseStaticWebAssets();
}

// ─── Telemetry & Key Vault ───────────────────────────────────────────
builder
    .AddPoMiniGamesTelemetry()
    .AddPoMiniGamesKeyVault()
    .AddPoMiniGamesLogging();

// ─── Data Protection (encrypted cookies) ──────────────────────
// Pinned BEFORE auth so AddCookie picks up the configured IDataProtector.
var storageAccountName = builder.Configuration["PoMiniGames:Storage:TableService:AccountName"];
builder.Services.AddPoMiniGamesDataProtection(builder.Environment, storageAccountName);

// ─── Application services ────────────────────────────────────────────
builder.Services
    .Configure<PoMiniGames.Features.PoCoupleQuiz.CoupleQuizOptions>(
        builder.Configuration.GetSection(PoMiniGames.Features.PoCoupleQuiz.CoupleQuizOptions.SectionName))
    .AddPoMiniGamesStorage(builder.Configuration)
    .AddPoMiniGamesGameServices()
    .AddPoMiniGamesRateLimiting();
builder.Services.AddSingleton<ConfigurationDiagnosticsSnapshotProvider>();

// ─── SignalR (shared by all multiplayer hubs) ─────────────────────────────────
// Enrich every hub invocation's logs with UserId/ConnectionId — the SignalR
// equivalent of RequestLogContextMiddleware for HTTP (see HubLogContextFilter).
builder.Services.AddSingleton<HubLogContextFilter>();
builder.Services.AddSignalR(options =>
{
    options.AddFilter<HubLogContextFilter>();
    // Only surface server-side exception detail to clients in Development.
    // In Production this would leak internal exception messages/stack traces
    // over the wire to every connected client.
    options.EnableDetailedErrors = builder.Environment.IsDevOrTest();
    // Server-side idle timeout + keep-alive. The earlier ~150s hang I observed
    // in the browser was the client WebSocket waiting for an idle close from
    // the server. These match SignalR's documented defaults for ASP.NET Core
    // 9 but pin them explicitly so the contract is grep-able.
    //   • KeepAlive: server pings the client every 30s
    //   • ClientTimeoutInterval: server tears the connection down after 60s
    //     without a pong. Clients should configure WithAutomaticReconnect().
    options.KeepAliveInterval = TimeSpan.FromSeconds(30);
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
    // Per-message caps: the largest JSON we've seen in this app is the
    // PoMarbleRace leaderboard (~250KB). 256KB headroom keeps a single game
    // payload safe while still bounding the worst-case memory spike.
    options.MaximumReceiveMessageSize = 256 * 1024;
    options.StreamBufferCapacity = 32;
}).AddJsonProtocol(options =>
{
    options.PayloadSerializerOptions.Converters.Add(
        new System.Text.Json.Serialization.JsonStringEnumConverter(
            System.Text.Json.JsonNamingPolicy.CamelCase));
    // Source-generated metadata for the Shared hub DTOs, reflection behind it.
    PoMiniGames.Shared.Games.HubJsonContext.Apply(options.PayloadSerializerOptions);
});

// ─── Swagger / OpenAPI ───────────────────────────────────────────────
builder.Services.AddProblemDetails();
builder.Services.AddValidatorsFromAssemblyContaining<PoMiniGames.Shared.Validation.PlayerDisplayNameValidator>();
// CSRF: synchroniser tokens for every state-changing /api/* call. See
// AntiforgeryExtensions for why UseAntiforgery() alone does not cover a JSON API.
builder.Services.AddPoMiniGamesAntiforgery();
builder.Services.AddOpenApi();

// Bug fix QA #10: gzip / brotli response compression for the Blazor WASM
// payload. Cold-start win is largest on the .native / .runtime / .js files
// (e.g. dotnet.native.*.js.gz drops 4 MB → 1.2 MB over the wire). The
// middleware is added below `UseHttpsRedirection`/exception handling so it
// runs as early as possible for the static WASM paths.
builder.Services.AddResponseCompression(options =>
{
    options.EnableForHttps = true;
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProvider>();
    options.Providers.Add<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProvider>();
    options.MimeTypes = Microsoft.AspNetCore.ResponseCompression.ResponseCompressionDefaults.MimeTypes.Concat(
    [
        // Application-specific MIME types: ensure the static WASM payload
        // is compressed on the wire. Without these, framework defaults
        // (which only include text/css, application/javascript, etc.) skip
        // application/wasm entirely.
        "application/wasm",
        "application/octet-stream",
        "application/json",
        "image/svg+xml",
    ]);
});
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.BrotliCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);
builder.Services.Configure<Microsoft.AspNetCore.ResponseCompression.GzipCompressionProviderOptions>(o => o.Level = System.IO.Compression.CompressionLevel.Fastest);

// ─── CORS — only registered in Development ───────────────────────────────
// When the Blazor WASM client runs on its own Kestrel port (e.g. :5261 from
// `dotnet run --project src/PoMiniGames.Client`) the API lives at :5080, so
// every /api/* fetch becomes a cross-origin request. The default browser
// preflight would block it without Access-Control-Allow-Origin. We register
// a Development-only policy permitting the two ports the client's
// launchSettings.json exposes (http://5261 + https://7208) plus the API host
// itself. Production and Staging stay same-origin (the host serves both the
// WASM and the API) so no CORS service is registered there.
if (builder.Environment.IsDevelopment())
{
    builder.Services.AddCors(options =>
    {
        options.AddPolicy("PoMiniGamesDevSpa", policy =>
        {
            policy.WithOrigins(
                    "http://localhost:5261",
                    "https://localhost:7208",
                    "http://localhost:5080",
                    "https://localhost:5080")
                .AllowAnyHeader()
                .AllowAnyMethod()
                // Allow credentials so the antiforgery cookie round-trips when the
                // client runs on its own dev port.
                .AllowCredentials();
        });
    });
}

var app = builder.Build();

// Production only: bind the singleton AzureBlobXmlRepository into the
// framework's KeyManagementOptions so DataProtection reads the same key-ring
// instance the rest of the app sees. Done here (post-Build) because we need
// the service provider to resolve the singleton; BuildServiceProvider from a
// raw IServiceCollection creates a duplicate container and is explicitly
// discouraged by Microsoft. Test/Dev skip this — they use the on-disk
// PersistKeysToFileSystem path configured inside AddPoMiniGamesDataProtection.
if (app.Environment.IsProduction())
{
    var xmlRepo = app.Services.GetRequiredService<AzureBlobXmlRepository>();
    app.Services.GetRequiredService<Microsoft.Extensions.Options.IOptions<Microsoft.AspNetCore.DataProtection.KeyManagement.KeyManagementOptions>>()
        .Value.XmlRepository = xmlRepo;
}

// ─── Production safety guards ─────────────────────────────────────────
// All Production-fail-fast checks live in StartupSecretValidator (IHostedService
// that runs before the first HTTP request). Single source of truth — see
// src/PoMiniGames.Api/Infrastructure/StartupSecretValidator.cs.

// Initialize storage eagerly so the database is ready before the first request.
app.Services.GetRequiredService<StorageService>().Initialize();

// Ensure the additional tables and blob containers for the consolidated games
// (PoCoupleQuiz, PoFunQuiz) exist. Runs idempotently; failures are logged
// but never block startup.
try
{
    await app.Services.GetRequiredService<StorageInitializer>().InitializeAsync();
}
catch (Exception ex)
{
    app.Logger.StorageInitializerError(ex);
}

// ─── Exception handling & developer tooling ──────────────────────────
// Response compression must be the FIRST middleware that touches the response body —
// any later middleware that calls `WriteAsync` or sets `Content-Length` directly will
// bypass it. Static files are streamed with `SendFile` (which honours the compression
// layer, see UsePoMiniGamesStaticFiles), so this ordering works for the WASM payload too.
app.UseResponseCompression();
// Which build answered: the commit SHA the deploy checks against what it shipped.
app.UsePoMiniGamesCommitStamp();

// CORS: applies only in Development (see registration above). Must precede
// UsePlayerIdentity / MapPoMiniGamesEndpoints so preflight OPTIONS requests
// are answered before anything else looks at them.
if (app.Environment.IsDevelopment())
{
    app.UseCors("PoMiniGamesDevSpa");
}
app.UseMiddleware<RequestLogContextMiddleware>();
app.UsePoMiniGamesRequestLogging();
if (app.Environment.IsProduction())
{
    app.UseExceptionHandler();
    app.UseHsts();
}
else
{
    // Swallow BadHttpRequestException (e.g. invalid request headers from scanners) silently in dev
    // so Serilog doesn't flood the output with ERROR-level stack traces.
    app.Use(async (ctx, next) =>
    {
        try { await next(ctx); }
        catch (Microsoft.AspNetCore.Http.BadHttpRequestException ex)
        {
            if (!ctx.Response.HasStarted)
            {
                ctx.Response.StatusCode = ex.StatusCode;
            }
        }
    });
    app.UseDeveloperExceptionPage();
}

// ─── Security headers (nosniff, DENY framing, minimal CSP) ───────────
app.UsePoMiniGamesSecurityHeaders();

app.MapOpenApi();
app.MapScalarApiReference(options =>
{
    options.Title = "PoMiniGames API";
    options.Theme = ScalarTheme.Purple;
});

// ─── Boot chain: revalidate the shell, /_framework and the js/css ────
app.UsePoMiniGamesBootChainCachePolicy();

// ─── Blazor WASM hosting ─────────────────────────────────────────────
app.UseBlazorFrameworkFiles();

// ─── Client appsettings gate (client copy only, never the server's) ──
app.UsePoMiniGamesClientAppSettings();

// ─── Static files: glb/gltf/ksplat types, compression-friendly headers ─
app.UsePoMiniGamesStaticFiles();

app.UsePlayerIdentity();
app.UseRateLimiter();

// CSRF gate. Deliberately AFTER UsePlayerIdentity: the antiforgery token is bound to
// the player's identity claims, so validating before the principal is established would
// reject every token this same player was just issued. After UseRateLimiter too, so a flood
// of token-less writes is shed by the limiter rather than each one paying for a
// Data Protection unprotect.
app.UsePoMiniGamesAntiforgery();

// ─── Minimal API endpoints + SignalR hubs (one ordered registration) ──
// The whole route table lives in EndpointRouteExtensions.MapPoMiniGamesEndpoints.
app.MapPoMiniGamesEndpoints();

// ─── Fake /api/* fallback ─────────────────────────────────────────────
// The SPA fallback below (`MapFallbackToFile("index.html")`) intercepts every
// unmatched path and returns the Blazor shell. That is correct for client
// routes like /leaderboards, but it silently converts undefined /api/* paths
// (e.g. /api/couplequiz/game-history, /api/game/session) into a 200 OK with a 5019-byte HTML body, which clients
// may deserialise as data and corrupt state. The handler below short-circuits
// any /api/* path that fell through to a typed 404 JSON before the SPA
// fallback runs.
app.Map("/api/{*rest:nonfile}", () => Results.NotFound(new
{
    error = "no_such_endpoint",
    detail = "The requested /api/* path is not mapped. Check the OpenAPI document at /openapi/v1.json for the live route table."
}))
.ExcludeFromDescription(); // Keep the catch-all out of the OpenAPI surface.

// ─── One-time cache bust for stale _framework/*.pdb 204 responses ─────
app.UsePoMiniGamesOnceCacheBust();

// ─── SPA fallback ────────────────────────────────────────────────────
app.MapFallbackToFile("index.html");

try
{
    // Log the actual bound addresses rather than a hardcoded port — the port is
    // owned by launchSettings.json in dev and the platform (PORT/WEBSITE_*) in prod,
    // and a stale constant here silently lies the first time either changes.
    // app.Urls is only populated once the server has bound, so log on the
    // ApplicationStarted signal, not before Run().
    app.Lifetime.ApplicationStarted.Register(() =>
        Log.Information("PoMiniGames listening on {Addresses}", string.Join(", ", app.Urls)));
    app.Run();
}
catch (Exception ex)
{
    Log.Fatal(ex, "PoMiniGames terminated unexpectedly");
}
finally
{
    Log.CloseAndFlush();
}

/// <summary>Partial class anchor for WebApplicationFactory in tests.</summary>
public partial class Program { }
