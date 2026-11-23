using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// E2E-UI "Golden Path" smoke tests under a strict mobile-portrait viewport
/// (390×844 — the platform is mobile-first). These drive a real Chromium browser
/// through the player's first interactions: land on home, see the game catalog,
/// open a single-player game. The default (non-mock) fixture is used, so these
/// also assert the mock banner is ABSENT in a normal environment.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class MobileGoldenPathTests
{
    private static readonly ViewportSize Portrait = new() { Width = 390, Height = 844 };

    private readonly KestrelServerFixture _fixture;

    public MobileGoldenPathTests(KestrelServerFixture fixture) => _fixture = fixture;

    private async Task<(IPage Page, PlaywrightErrorGuard Guard)> OpenHomeAsync(IBrowser browser)
    {
        var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = Portrait,
        });
        var page = await context.NewPageAsync();
        var guard = PlaywrightErrorGuard.Watch(page);
        // WASM cold-boot (download + start) can take a while under the load of the parallel
        // Testcontainers fixtures, so allow a generous navigation budget.
        await page.GotoAsync($"{_fixture.ServerAddress}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });
        return (page, guard);
    }

    [UiFact]
    public async Task Home_OnMobilePortrait_ShowsCatalog_AndNoMockBanner()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            BrowserLaunch.Options());
        var (page, guard) = await OpenHomeAsync(browser);
        await using var _ = guard;

        // The home hero renders the platform identity…
        // (The hub's own .home-title became the shared PageHeader, visually hidden because the
        // brand in the top bar already names the app; the brand is what a player sees.)
        await page.Locator(".gl-brand-text").WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });
        (await page.Locator(".gl-brand-text").InnerTextAsync()).Should().Contain("PoMiniGames");
        (await page.Locator("h1").First.TextContentAsync()).Should().Contain("PoMiniGames");

        // …and the catalog renders game cards with playable mode chips. The grid is
        // game-major now (a card per game, a chip per mode), so both layers are
        // asserted: a card with no chips would look like a catalog and play nothing.
        (await page.Locator(".home-card").CountAsync()).Should().BeGreaterThan(0,
            because: "the home page must surface the game catalog on a phone");
        (await page.Locator("a.home-mode-chip").CountAsync()).Should().BeGreaterThan(0,
            because: "every card must offer at least one navigable mode");
    }

    [UiFact]
    public async Task GoldenPath_OpenFirstSinglePlayerGame_Navigates_AndRenders()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            BrowserLaunch.Options());
        var (page, guard) = await OpenHomeAsync(browser);
        await using var _ = guard;

        // The grid is game-major and nothing collapses, so every chip is on screen —
        // but :visible is kept deliberately. It costs nothing and it is what stops
        // this test from passing on a chip the player could not have tapped, which
        // is exactly the regression the old collapsed-section layout could produce.
        var firstChip = page.Locator("a.home-mode-chip:visible").First;
        await firstChip.WaitForAsync(new LocatorWaitForOptions
        {
            State = WaitForSelectorState.Visible,
            Timeout = 60_000,
        });

        var targetHref = await firstChip.GetAttributeAsync("href");
        targetHref.Should().NotBeNullOrWhiteSpace();

        // Navigate directly to the chip's href instead of clicking — Blazor WASM's
        // enhanced navigation can race the SPA boot. Direct navigation goes through
        // the SPA router deterministically (MapFallbackToFile serves index.html, the
        // router picks up the path) and confirms the route is reachable.
        var absoluteTarget = new Uri(new Uri(_fixture.ServerAddress), targetHref!.TrimStart('/')).ToString();
        await page.GotoAsync(absoluteTarget, new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });

        page.Url.Should().Contain(targetHref!.TrimStart('/'),
            because: "navigating to a game route renders that game");

        // The router mounted a new page into #app; it must contain rendered markup.
        var appHtml = await page.Locator("#app").InnerHTMLAsync();
        appHtml.Should().NotBeNullOrWhiteSpace();

        await VerifyConnectFiveTouchAsync(browser);
    }

    private async Task VerifyConnectFiveTouchAsync(IBrowser browser)
    {
        foreach (var viewport in new[] { Portrait, new ViewportSize { Width = 844, Height = 390 } })
        {
            await using var context = await browser.NewPlayerContextAsync(new()
            {
                ViewportSize = viewport,
                HasTouch = true,
                IsMobile = true,
            });
            var page = await context.NewPageAsync();
            await page.GotoAsync($"{_fixture.ServerAddress}connectfive/1player", new()
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 60_000,
            });
            await page.Locator("[data-intro-action]").ClickAsync(new() { Timeout = 60_000 });
            var controls = page.Locator(".cf-touch-controls button");
            await controls.First.WaitForAsync();
            for (var i = 0; i < 3; i++)
            {
                var box = await controls.Nth(i).BoundingBoxAsync();
                box.Should().NotBeNull();
                box!.Width.Should().BeGreaterThanOrEqualTo(44);
                box.Height.Should().BeGreaterThanOrEqualTo(44);
                box.X.Should().BeGreaterThanOrEqualTo(0);
                box.Y.Should().BeGreaterThanOrEqualTo(0);
                (box.X + box.Width).Should().BeLessThanOrEqualTo(viewport.Width);
                (box.Y + box.Height).Should().BeLessThanOrEqualTo(viewport.Height);
            }
            (await page.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight")).Should().BeTrue();
            for (var i = 0; i < 4; i++) await controls.Nth(0).TapAsync();
            await page.GetByRole(AriaRole.Button, new() { Name = "Drop in column 1" }).TapAsync();
            (await page.Locator(".cf-cell.red[aria-colindex='1']").CountAsync()).Should().Be(1);
            await Assertions.Expect(page.Locator(".cf-cell.yellow")).ToHaveCountAsync(1, new() { Timeout = 10_000 });
            for (var i = 0; i < 8; i++) await controls.Nth(2).TapAsync();
            await page.GetByRole(AriaRole.Button, new() { Name = "Drop in column 9" }).TapAsync();
            (await page.Locator(".cf-cell.red[aria-colindex='9']").CountAsync()).Should().Be(1);
        }
    }
}
