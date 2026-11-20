using System.Reflection;
using Microsoft.AspNetCore.Http.Features;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// The HTTP pipeline stages Program.cs composes, one method per stage.
/// </summary>
/// <remarks>
/// <para>
/// These live here rather than inline in Program.cs because each one is a self-contained
/// rule with a long justification, and a composition root that is 60% prose about cache
/// headers hides the order the stages have to run in — which is the only thing the
/// composition root is for. The call order in Program.cs is the contract; the behaviour is
/// in the method.
/// </para>
/// <para>
/// Every method here is registered by <c>app.Use…</c>, so it MUST keep the position it is
/// called from. Three are order-sensitive and say so: the appsettings gate must precede
/// <c>UseStaticFiles</c>, response compression must precede anything that writes a body, and
/// the framework-files middleware must precede the appsettings gate.
/// </para>
/// </remarks>
internal static class AppPipelineExtensions
{
    /// <summary>
    /// Stamps <c>X-Commit</c> on every response: the SHA the deploy checks against what it
    /// shipped. Read from the informational version (<c>&lt;version&gt;+&lt;sha&gt;</c> the SDK
    /// stamps in), and set in <c>OnStarting</c> so a response the exception handler rewrites
    /// keeps it.
    /// </summary>
    public static WebApplication UsePoMiniGamesCommitStamp(this WebApplication app)
    {
        var commit = typeof(global::Program).Assembly
            .GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
            .Split('+') is [_, var sha] ? sha : "unknown";

        app.Use((ctx, next) =>
        {
            ctx.Response.OnStarting(() =>
            {
                ctx.Response.Headers["X-Commit"] = commit;
                return Task.CompletedTask;
            });
            return next(ctx);
        });

        return app;
    }

    /// <summary>
    /// The response-header baseline every route gets.
    /// </summary>
    /// <remarks>
    /// HTTPS redirection is handled by App Service (<c>httpsOnly</c> in
    /// <c>infra/resources.bicep</c>), which terminates TLS before the request reaches Kestrel.
    /// The CSP covers framing, <c>&lt;base&gt;</c> and plugins only: a script-src policy needs
    /// hashes for the inline import map and boot scripts in index.html, so it has to be added
    /// together with those.
    /// </remarks>
    public static WebApplication UsePoMiniGamesSecurityHeaders(this WebApplication app)
    {
        // The 3D models' host when they are served from Blob Storage (UsePoMiniGamesModelRedirect):
        // the loaders fetch them, so the redirect target must be allowed by connect-src.
        var modelsOrigin = ModelsBaseUrl(app) is { } models ? " " + models.GetLeftPart(UriPartial.Authority) : "";
        app.Use(async (ctx, next) =>
        {
            var headers = ctx.Response.Headers;
            headers.XContentTypeOptions = "nosniff";
            headers.XFrameOptions = "DENY";
            headers["Referrer-Policy"] = "strict-origin-when-cross-origin";
            headers.ContentSecurityPolicy =
                "default-src 'self'; " +
                "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; " +
                "style-src 'self' 'unsafe-inline'; " +
                "img-src 'self' data: blob: https://*.wikimedia.org; " +
                // Brawl's highlight reel and PoEcosystem's clip share hand a <video> a
                // blob URL; with no media-src, default-src 'self' blocked playback.
                "media-src 'self' blob:; " +
                "font-src 'self' data:; " +
                // `blob:` is load-bearing: three.js's GLTFLoader turns an embedded glTF
                // texture into a blob URL and fetches it, so without it every textured
                // model logs "Couldn't load texture" and renders untextured. `img-src`
                // already allows blob: for the <img> path.
                // archive-api is the historical-weather host PoCapitol's scenario reads;
                // api.open-meteo.com (forecast) does not cover it.
                "connect-src 'self' blob: ws: wss: https://cdn.jsdelivr.net https://api.open-meteo.com https://archive-api.open-meteo.com https://geocoding-api.open-meteo.com https://www.wikidata.org" + modelsOrigin + "; " +
                "worker-src 'self' blob:; " +
                "frame-ancestors 'none'; base-uri 'self'; object-src 'none'";
            await next();
        });

        return app;
    }

    /// <summary>
    /// Forces revalidation on the SPA boot chain: the shell (<c>index.html</c>), the
    /// extensionless client routes served from it, <c>/_framework/*</c> and the
    /// non-fingerprinted <c>.css</c>/<c>.js</c>.
    /// </summary>
    /// <remarks>
    /// These files are how a browser discovers the current fingerprinted asset names. If they
    /// sit in the HTTP cache, a rebuild changes the fingerprints and an already-open tab keeps
    /// requesting the old (now 404) files → "An unhandled error has occurred" on load. The same
    /// mix happens after a deploy: static-web-asset fingerprinting is off, so <c>js/*.js</c>
    /// and the shell carry no fingerprint and, with no Cache-Control, browsers keep them
    /// "fresh" by heuristic for hours — a reload then boots the new client against the old
    /// <c>js/platform/engineLoader.js</c> and the game page shows "could not load". Every environment
    /// therefore forces revalidation; the fingerprinted assets stay cacheable, and ETag
    /// revalidation makes the cost one 304 per file.
    /// </remarks>
    public static WebApplication UsePoMiniGamesBootChainCachePolicy(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            var path = ctx.Request.Path.Value ?? "/";
            // /api/* is not the boot chain: the extensionless heuristic below used to catch
            // API routes whose last segment has no dot (e.g. the content-addressed
            // /api/povoxelstrike/assets/{hash}) and this OnStarting overwrote the immutable
            // cache header the handler had set — dev silently diverged from production.
            var noCache = !path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
                && (path.StartsWith("/_framework", StringComparison.OrdinalIgnoreCase)
                || !Path.HasExtension(path)                          // SPA shell routes ("/", "/connectfive/demo")
                || path.EndsWith(".css", StringComparison.OrdinalIgnoreCase)
                || path.EndsWith(".js", StringComparison.OrdinalIgnoreCase));
            if (noCache)
            {
                ctx.Response.OnStarting(() =>
                {
                    ctx.Response.Headers.CacheControl = "no-cache";
                    return Task.CompletedTask;
                });
            }
            await next();
        });

        return app;
    }

    /// <summary>
    /// Serves the <em>client's</em> <c>appsettings*.json</c>, never the server's.
    /// </summary>
    /// <remarks>
    /// <para>
    /// The Blazor WASM runtime fetches <c>/appsettings.json</c> at startup and treats a 404 as a
    /// fatal init error (MONO_WASM: download failed 404), so the request has to be answered. It
    /// is answered from the client's staged copy — public API base address and feature flags —
    /// because the server's own appsettings carry the Key Vault endpoint and AAD client ids and
    /// must never reach a browser.
    /// </para>
    /// <para>
    /// MUST be registered before <c>UseStaticFiles</c> so the gate fires before the
    /// static-files pipeline reads a file from disk.
    /// </para>
    /// </remarks>
    public static WebApplication UsePoMiniGamesClientAppSettings(this WebApplication app)
    {
        app.Use(async (ctx, next) =>
        {
            var p = ctx.Request.Path.Value;
            if (p is null || !p.StartsWith("/appsettings", StringComparison.OrdinalIgnoreCase) ||
                !p.EndsWith(".json", StringComparison.OrdinalIgnoreCase))
            {
                await next(ctx);
                return;
            }

            // Allowlist the filenames; anything else under appsettings*.json (e.g. a traversal
            // attempt) is a 404 rather than a disk read.
            var fileName = p.TrimStart('/');
            if (fileName.Contains('/') || fileName.Contains('\\') ||
                !(fileName.Equals("appsettings.json", StringComparison.OrdinalIgnoreCase) ||
                  fileName.Equals("appsettings.Development.json", StringComparison.OrdinalIgnoreCase)))
            {
                ctx.Response.StatusCode = StatusCodes.Status404NotFound;
                return;
            }

            // Resolve the client's copy: the API's StageBlazorClientStaticWebAssets target
            // copies it into <bin>/wwwroot/appsettings*.json. Never ContentRootPath or
            // AppContext.BaseDirectory — those hold the server's appsettings.
            var env = ctx.RequestServices.GetRequiredService<IWebHostEnvironment>();
            var wwwrootRoot = env.WebRootPath;
            if (string.IsNullOrEmpty(wwwrootRoot))
            {
                // In `dotnet run` WebRootPath may be the source project root, where no
                // wwwroot/ exists, so look under bin/wwwroot instead.
                wwwrootRoot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
            }

            var candidate = Path.Combine(wwwrootRoot, fileName);
            ctx.Response.StatusCode = StatusCodes.Status200OK;
            ctx.Response.ContentType = "application/json";
            ctx.Response.Headers.CacheControl = "no-store";
            if (File.Exists(candidate))
            {
                await ctx.Response.SendFileAsync(candidate);
            }
            else
            {
                // An empty payload still boots the WASM runtime; a 404 bricks the SPA.
                await ctx.Response.WriteAsync("{}");
            }
        });

        return app;
    }

    /// <summary>
    /// Serves <c>wwwroot</c> with the content types and headers the 3D games need.
    /// </summary>
    /// <remarks>
    /// glTF binary is not in the framework's default extension→MIME map, and
    /// <c>StaticFileMiddleware</c> skips any file whose content type it cannot resolve — the
    /// request then falls through to the SPA fallback and the caller gets the Blazor shell.
    /// PoMarbleRace loads its whole course from <c>wwwroot/models/marble_track.glb</c>, so
    /// without this registration the game has no track at all. The provider is a copy of the
    /// default one rather than a mutation of the shared static, so nothing else in the
    /// pipeline inherits the change.
    /// </remarks>
    /// <summary>
    /// Sends <c>/models/*</c> (the ~37 MB of 3D tracks and splats) to Blob Storage when
    /// <c>PoMiniGames:Models:BaseUrl</c> is set, so those bytes never count against the F1 plan's
    /// 165 MB/day data-out quota. Unset (dev, tests) the files are served from wwwroot as before.
    /// </summary>
    /// <remarks>
    /// Must precede <see cref="UsePoMiniGamesStaticFiles"/>: in production the deploy
    /// (scripts/pre-deploy.ps1) uploads the models and strips them from the package.
    /// </remarks>
    public static WebApplication UsePoMiniGamesModelRedirect(this WebApplication app)
    {
        if (ModelsBaseUrl(app) is not { } baseUrl) return app;
        var root = baseUrl.AbsoluteUri.TrimEnd('/');

        app.Use((ctx, next) =>
        {
            if (!ctx.Request.Path.StartsWithSegments("/models", out var rest) || !rest.HasValue)
            {
                return next(ctx);
            }
            ctx.Response.Headers.CacheControl = "public, max-age=86400";
            ctx.Response.Redirect(root + rest.Value + ctx.Request.QueryString.Value, permanent: false);
            return Task.CompletedTask;
        });

        return app;
    }

    private static Uri? ModelsBaseUrl(WebApplication app) =>
        Uri.TryCreate(app.Configuration["PoMiniGames:Models:BaseUrl"], UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps ? uri : null;

    public static WebApplication UsePoMiniGamesStaticFiles(this WebApplication app)
    {
        var contentTypeProvider = new Microsoft.AspNetCore.StaticFiles.FileExtensionContentTypeProvider();
        contentTypeProvider.Mappings[".glb"] = "model/gltf-binary";
        contentTypeProvider.Mappings[".gltf"] = "model/gltf+json";
        // PoCabinet draws its scanned court as a Gaussian splat (wwwroot/models/court.ksplat).
        contentTypeProvider.Mappings[".ksplat"] = "application/octet-stream";

        app.UseStaticFiles(new StaticFileOptions
        {
            ContentTypeProvider = contentTypeProvider,
            OnPrepareResponse = ctx =>
            {
                // Allow the compression middleware to wrap the body: Vary says the
                // representation depends on Accept-Encoding, dropping Content-Length stops the
                // framework taking the SendFile shortcut, and the body feature is replaced so
                // the bytes go through the response stream the compressor owns.
                ctx.Context.Response.Headers["Vary"] = "Accept-Encoding";
                ctx.Context.Response.Headers.Remove("Content-Length");
                ctx.Context.Features.Set<IHttpResponseBodyFeature>(
                    new StreamResponseBodyFeature(
                        ctx.Context.Response.Body,
                        ctx.Context.Features.Get<IHttpResponseBodyFeature>()!));
            }
        });

        return app;
    }
}
