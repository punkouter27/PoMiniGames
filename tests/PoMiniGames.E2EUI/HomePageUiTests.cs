using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// E2E-UI smoke tests. Drives a real Chromium browser via Microsoft.Playwright
/// against the live-Kestrel host, asserting the Blazor WASM client actually
/// renders (not just that the HTTP shell is served — that is E2E-API's job).
/// </summary>
/// <remarks>
/// Requires Playwright browsers installed once per machine:
/// <c>pwsh tests/E2EUI/bin/Debug/net10.0/playwright.ps1 install chromium</c>.
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class HomePageUiTests
{
    private readonly KestrelServerFixture _fixture;

    public HomePageUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [UiFact]
    public async Task Home_RendersBlazorClient_AndShowsAppName()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(
            BrowserLaunch.Options());
        var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);

        await page.GotoAsync($"{_fixture.ServerAddress}", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
        });

        // The WASM bootstrap replaces the #app loading placeholder once Blazor
        // has started; assert the page title carries the Po* identity.
        var title = await page.TitleAsync();
        title.Should().Contain("PoMiniGames");

        // The Blazor router mounts content into #app; after NetworkIdle it must
        // contain rendered markup, proving the WASM runtime booted.
        var appHtml = await page.Locator("#app").InnerHTMLAsync();
        appHtml.Should().NotBeNullOrWhiteSpace();
    }

    /// <summary>
    /// Profile A page shell: Radzen's theme is the FIRST stylesheet (the app's CSS after it wins every tie),
    /// linked once (one light and one dark file, never re-added by a Radzen page), the page has one h1, and the
    /// version stamp sits in the &lt;footer&gt; contentinfo landmark.
    /// </summary>
    [UiFact]
    public async Task Shell_LoadsRadzenThemeOnceAndFirst_OneH1_StampInFooter()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions { ViewportSize = new() { Width = 1366, Height = 768 } });
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);

        await page.GotoAsync($"{_fixture.ServerAddress}", new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });
        await page.Locator(".home-card").First.WaitForAsync(new LocatorWaitForOptions { Timeout = 60_000 });

        const string Sheets = "() => [...document.querySelectorAll('link[rel=stylesheet]')].map(l => new URL(l.href).pathname)";
        var sheets = await page.EvaluateAsync<string[]>(Sheets);
        sheets[0].Should().Contain("_content/Radzen.Blazor/css/", because: "Radzen's theme loads before the app's CSS");
        sheets.Count(s => s.Contains("_content/Radzen.Blazor/css/", StringComparison.Ordinal)).Should().Be(2, because: "one light and one dark theme, once");
        Array.FindIndex(sheets, s => s.EndsWith("/css/po-tokens.css", StringComparison.Ordinal)).Should().BeGreaterThan(1);

        (await page.Locator("h1").CountAsync()).Should().Be(1);
        (await page.Locator("footer .po-version").CountAsync()).Should().Be(1);

        // A Radzen page (Leaderboards) keeps the same two links: nothing added, nothing removed.
        await page.EvaluateAsync("() => Blazor.navigateTo('/leaderboards')");
        await page.WaitForFunctionAsync("() => location.pathname === '/leaderboards'");
        // The page's theme ensure() has run once Radzen's script is in (it loads the script on demand).
        await page.WaitForFunctionAsync("() => !!window.Radzen", null, new PageWaitForFunctionOptions { Timeout = 30_000 });
        sheets = await page.EvaluateAsync<string[]>(Sheets);
        sheets.Count(s => s.Contains("_content/Radzen.Blazor/css/", StringComparison.Ordinal)).Should().Be(2);
        sheets[0].Should().Contain("_content/Radzen.Blazor/css/");
        (await page.Locator("h1").CountAsync()).Should().Be(1);
    }

    /// <summary>
    /// Profile B: the main menu fits one screen with no scrolling, on a laptop and on a small phone. The game grid
    /// is paged (js/platform/homePager.js); every page fits, every game is on exactly one page, and PageDown turns
    /// the page.
    /// </summary>
    [UiFact]
    public async Task Home_MenuFitsOneScreen_OnEveryPage_AtLaptopAndPhone()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        foreach (var (width, height, phone) in new[] { (1366, 768, false), (375, 667, true) })
        {
            var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions
            {
                ViewportSize = new ViewportSize { Width = width, Height = height },
                IsMobile = phone,
                HasTouch = phone,
            });
            var page = await context.NewPageAsync();
            await using var guard = PlaywrightErrorGuard.Watch(page);
            await page.GotoAsync($"{_fixture.ServerAddress}", new PageGotoOptions { WaitUntil = WaitUntilState.Load, Timeout = 60_000 });
            await page.Locator(".home-card").First.WaitForAsync(new LocatorWaitForOptions { Timeout = 60_000 });
            // The pager has measured once the dots exist and the last card is off page 1 (or everything fits).
            await page.WaitForFunctionAsync(
                "() => document.querySelectorAll('.home-pager__dot').length > 0 && document.fonts.status === 'loaded'",
                null, new PageWaitForFunctionOptions { Timeout = 30_000 });
            await page.WaitForTimeoutAsync(500);

            var pages = await page.Locator(".home-pager__dot").CountAsync();
            var cards = await page.Locator(".home-card").CountAsync();
            var seen = new HashSet<string>();
            for (var p = 0; p < pages; p++)
            {
                if (p > 0)
                {
                    await page.Locator(".home-pager__dot").Nth(p).ClickAsync();
                    await page.WaitForFunctionAsync("i => document.querySelectorAll('.home-pager__dot')[i]?.getAttribute('aria-current') === 'page'", p);
                }
                var overflow = await page.EvaluateAsync<int[]>(
                    "() => [document.documentElement.scrollHeight - innerHeight, document.documentElement.scrollWidth - innerWidth]");
                var (scroll, wide) = (overflow[0], overflow[1]);
                scroll.Should().BeLessThanOrEqualTo(0, $"page {p + 1} of the menu must fit a {width}x{height} screen");
                wide.Should().BeLessThanOrEqualTo(0, $"page {p + 1} of the menu must not scroll sideways at {width}px");
                foreach (var title in await page.Locator(".home-card:not([hidden]) .home-card-title").AllInnerTextsAsync())
                    seen.Add(title.Trim()).Should().BeTrue($"{title} must be on one page only");
            }
            seen.Count.Should().Be(cards, "every game must be reachable from some page");

            if (pages > 1)
            {
                await page.Locator(".home-pager__dot").First.ClickAsync();
                await page.Keyboard.PressAsync("PageDown");
                await page.WaitForFunctionAsync("() => document.querySelectorAll('.home-pager__dot')[1]?.getAttribute('aria-current') === 'page'");
            }
            await context.CloseAsync();
        }
    }
}
