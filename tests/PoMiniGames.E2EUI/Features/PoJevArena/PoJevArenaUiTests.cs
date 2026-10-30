using Microsoft.Playwright;

namespace PoMiniGames.E2EUI.Features.PoJevArena;

/// <summary>
/// Journey 1 end to end against the real Kestrel host under the "Test" environment, where every
/// brain (local and Jev) is the deterministic stub (TestBudgetGuard; the stub always takes the first
/// offered option, i.e. melee_charge on the nearest threat, so matches genuinely finish):
/// guest sign-in → Factory preview per ability → CPU-drafted squads → deploy → the match plays to a
/// result → the Black Box scrubs and the inspector follows the scrubbed frame.
/// Screenshots land in artifacts/pojevarena/ for the readability review.
/// One method: this tier holds 25 in total.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoJevArenaUiTests
{
    private readonly KestrelServerFixture _fixture;

    public PoJevArenaUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Journey_DraftDeployWatchAndScrub()
    {
        var shots = Path.Combine("artifacts", "pojevarena");
        Directory.CreateDirectory(shots);

        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = new ViewportSize { Width = 1440, Height = 900 },
        });
        // No context-wide fake-auth headers: they ride along on the MSAL CDN script and fail its CORS
        // preflight (a harness error, not the page's). ?autoGuest=1 below signs the browser in.
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        // Generic "Failed to load resource" console lines are covered, with their URL, by the
        // response hook. The play-session mint is excluded: under ?autoGuest=1 it races the guest
        // sign-in (its antiforgery token predates the identity) and 403s on every game page — a
        // known framework issue, tolerated by PlaySessionService, not this page's.
        page.Console += (_, msg) => { if (msg.Type is "error" && !msg.Text.StartsWith("Failed to load resource", StringComparison.Ordinal)) errors.Add(msg.Text); };
        page.PageError += (_, err) => errors.Add(err);
        page.Response += (_, r) =>
        {
            if (r.Status >= 400 && !r.Url.Contains("/api/play/sessions/", StringComparison.Ordinal))
                errors.Add($"HTTP {r.Status} {r.Request.Method} {r.Url}");
        };

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}/pojevarena/demo?autoGuest=1",
            new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync(new() { Timeout = 30_000 });
        await page.Locator(".jev-add--blue").Nth(4).WaitForAsync(new() { Timeout = 30_000 });
        (await page.Locator(".jev-status").InnerTextAsync()).Should().Contain("ready", "the Test host serves the stub for every brain");

        // Factory (a drawer over the library): one preview capture per ability chip, so every
        // ability's wind-up/stance is reviewable.
        await page.GetByRole(AriaRole.Button, new() { Name = "New creature" }).ClickAsync();
        var factory = page.Locator(".jev-factory");
        foreach (var (label, id) in new[]
                 {
                     ("Spit glob", "spit_glob"), ("Hurl boulder", "hurl_boulder"), ("Mend bolt", "mend_bolt"),
                     ("Shield brace", "shield_brace"), ("Hard shell", "hard_shell"), ("Dodge dash", "dodge_dash"),
                 })
        {
            await factory.Locator(".jev-chip-pick", new() { HasText = label }).ClickAsync();
            await page.WaitForTimeoutAsync(1_200);
            await page.Locator(".jev-factory__preview").ScreenshotAsync(new() { Path = Path.Combine(shots, $"factory-{id}.png") });
        }
        await factory.GetByRole(AriaRole.Button, new() { Name = "Close" }).ClickAsync();

        // Demo only: the CPU drafts both squads itself.
        (await page.Locator(".jev-team--blue .jev-slot:not(.is-empty)").CountAsync()).Should().BeGreaterThan(0);
        (await page.Locator(".jev-team--red .jev-slot:not(.is-empty)").CountAsync()).Should().BeGreaterThan(0);
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "draft.png") });

        await page.GetByRole(AriaRole.Button, new() { Name = "Deploy battle" }).ClickAsync();
        await page.WaitForFunctionAsync("() => (window.PoJevArena?.state()?.frames ?? 0) > 300", null,
            new() { Timeout = 60_000 });
        // The battle runs full screen; holding Tab lays the stat HUD over the arena.
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "battle.png") });
        await page.Keyboard.DownAsync("Tab");
        await page.Locator(".jev-root[data-stats='on'] .jev-inspector--blue").WaitForAsync(new() { Timeout = 5_000 });
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "battle-stats.png") });
        (await page.Locator(".jev-inspector--blue").InnerTextAsync()).Should().Contain("melee_charge",
            "the blue inspector shows the distribution the stub returned");
        await page.Keyboard.UpAsync("Tab");
        await page.Locator(".jev-root[data-stats='off']").WaitForAsync(new() { Timeout = 5_000 });


        await page.WaitForFunctionAsync("() => window.PoJevArena?.state()?.over === true", null,
            new() { Timeout = 240_000, PollingInterval = 500 });
        // The whistle plays the kill cam; the demo shows no end-of-game modal and loops to a new draft.
        await page.WaitForTimeoutAsync(2_500);
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "killcam.png") });
        (await page.Locator("dialog.gps-modal[open]").CountAsync()).Should().Be(0, "the demo has no result modal");

        errors.Should().BeEmpty("the arena should run without console errors");
    }
}
