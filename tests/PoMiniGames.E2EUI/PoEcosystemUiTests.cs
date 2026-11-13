using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// PoEcosystem smoke through a real Chromium: the demo route boots the sim worker and the
/// three.js renderer, the island fills with creatures, and the crosshair inspector opens.
/// One method by design — the tier is capped at 25 (the 100/50/25/25 rule) and exercises
/// the end-to-end canvas rendering and UI dashboard components.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoEcosystemUiTests
{
    private readonly KestrelServerFixture _fixture;

    public PoEcosystemUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Demo_TheIslandIsAlive()
    {
        using var playwright = await Playwright.CreateAsync();
        // SwiftShader for the same reason as PoVoxelStrikeUiTests: this Playwright build's
        // headless launch has no WebGL, and GameShell would correctly show its fallback.
        var options = BrowserLaunch.Options();
        options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions { ViewportSize = MobileViewport.Portrait });

        // Per-request headers for the app origin only — context-wide headers would force a
        // CORS preflight on the three.js / cannon-es CDN imports and kill the engine.
        var origin = _fixture.ServerAddress.TrimEnd('/');
        await context.RouteAsync($"{origin}/**", async route =>
        {
            var headers = new Dictionary<string, string>(route.Request.Headers)
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            };
            await route.ContinueAsync(new RouteContinueOptions { Headers = headers });
        });
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
        var logs = new List<string>();
        page.Console += (_, msg) => { logs.Add($"[{msg.Type}] {msg.Text}"); if (msg.Type is "error") Console.WriteLine($"[browser:error] {msg.Text}"); };
        page.PageError += (_, err) => { logs.Add($"[pageerror] {err}"); Console.WriteLine($"[pageerror] {err}"); };
        page.RequestFailed += (_, req) => logs.Add($"[reqfail] {req.Url} {req.Failure}");
        page.Response += async (_, res) => { if (res.Url.Contains("/api/") || res.Url.Contains("appsettings")) logs.Add($"[res] {res.Status} {res.Url} {(res.Url.Contains("handshake") ? await res.TextAsync() : "")}"); };

        await page.GotoAsync($"{origin}/poecosystem/demo?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 120_000,
        });

        // Dismiss the intro card, then wait for the engine to report itself ready.
        var start = page.GetByRole(AriaRole.Button, new() { NameRegex = new System.Text.RegularExpressions.Regex("watch|start|play", System.Text.RegularExpressions.RegexOptions.IgnoreCase) }).First;
        var startCount = await start.CountAsync();
        if (startCount > 0) await start.ClickAsync(new LocatorClickOptions { Timeout = 15_000 });

        try
        {
            await page.WaitForFunctionAsync("() => window.__poeco?.()?.state?.ready === true", null,
                new PageWaitForFunctionOptions { Timeout = 25_000, PollingInterval = 250 });
        }
        catch (TimeoutException ex)
        {
            var snap = await page.EvaluateAsync<string>(@"() => JSON.stringify({
                startCount: " + startCount + @",
                url: location.href,
                body: document.body?.innerText?.slice(0, 500),
                hasGlobal: !!window.PoEcosystem,
                engine: (() => { try { const e = window.__poeco?.(); return e ? { ready: e.state?.ready, frames: e.state?.frames, mode: e.state?.mode, errors: e.state?.errors, count: e.creatureCount } : null; } catch (err) { return String(err); } })(),
                canvasCount: document.querySelectorAll('canvas').length
            })");
            throw new TimeoutException($"DIAG: {snap} | LOGS: {string.Join(" || ", logs)}", ex);
        }

        // The world is populated and the renderer is drawing frames.
        var alive = await page.EvaluateAsync<int>("() => window.__poeco().creatureCount");
        Assert.True(alive > 20, $"expected a populated island, saw {alive} creatures");
        await page.WaitForFunctionAsync("() => window.__poeco().state.frames > 2", null,
            new PageWaitForFunctionOptions { Timeout = 60_000, PollingInterval = 250 });
        Assert.NotNull(await page.QuerySelectorAsync("#poeco-world canvas"));

        // Look around until the crosshair finds a creature, inspect it, and read the panel.
        var handle = await page.EvaluateAsync<int?>(@"async () => {
            const e = window.__poeco(); const r = e.state.renderer;
            for (let k = 0; k < 150 && !r.hovered; k++) { r.playerState.look(20, 0); await new Promise(res => setTimeout(res, 50)); }
            if (!r.hovered) return null;
            e.select(r.hovered.handle);
            return r.hovered.handle;
        }");
        Assert.NotNull(handle);

        var inspector = page.Locator("[data-testid=poeco-inspector]");
        await inspector.WaitForAsync(new LocatorWaitForOptions { State = WaitForSelectorState.Visible, Timeout = 20_000 });
        var text = await inspector.InnerTextAsync();
        Assert.Contains("Hunger", text, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("boldness", text, StringComparison.OrdinalIgnoreCase);
    }
}
