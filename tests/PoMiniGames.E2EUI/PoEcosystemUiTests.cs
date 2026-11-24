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

    [UiFact]
    public async Task Demo_TheIslandIsAlive()
    {
        using var playwright = await Playwright.CreateAsync();
        // Windows: the real GPU (BrowserLaunch). Under SwiftShader the island's engine never reported ready within
        // 180 s on either host (AGENTS.md, 2026-11-22 and the v4 audit), so the test measured the rasteriser, not
        // the game. Elsewhere SwiftShader, because this Playwright build's headless launch has no WebGL there and
        // GameShell would correctly show its fallback.
        var options = BrowserLaunch.Options();
        if (!OperatingSystem.IsWindows())
            options.Args = ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];
        await using var browser = await playwright.Chromium.LaunchAsync(options);
        var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions { ViewportSize = MobileViewport.Portrait });

        var origin = _fixture.ServerAddress.TrimEnd('/');
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
        page.Console += (_, msg) => { if (msg.Type is "error") Console.WriteLine($"[browser:error] {msg.Text}"); };
        page.PageError += (_, err) => Console.WriteLine($"[pageerror] {err}");

        await page.GotoAsync($"{origin}/poecosystem/demo", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.Load,
            Timeout = 120_000,
        });

        // Dismiss the start card with its one button, OK (data-intro-action), then wait for the engine to report
        // itself ready. The old "watch|start|play" name never matched OK, so the card stayed up, the engine never
        // started, and the 180 s ready wait timed out on every host (v4 audit 2026-11-24).
        var start = page.Locator("dialog[open] [data-intro-action]").First;
        await start.WaitForAsync(new LocatorWaitForOptions { Timeout = 60_000 });
        await start.ClickAsync(new LocatorClickOptions { Timeout = 15_000 });

        await page.WaitForFunctionAsync("() => window.__poeco?.()?.state?.ready === true", null,
            new PageWaitForFunctionOptions { Timeout = 180_000, PollingInterval = 250 });

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
