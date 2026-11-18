using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// The /diag status page (Po standard, 2026-11-18): it renders the report from /api/diag at
/// phone and desktop width as po-diag__card cards in the API / Data / Services groups, under
/// the shared header (app name left, settings gear right), with the vYYMMDD build stamp
/// visible bottom-right, no sideways scroll and zero console errors (PlaywrightErrorGuard
/// fails the test on any).
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class DiagPageUiTests
{
    private readonly KestrelServerFixture _fixture;

    public DiagPageUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    [Fact]
    public async Task Diag_RendersAtPhoneAndDesktop_WithTheBuildStamp_AndNoConsoleErrors()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());

        foreach (var viewport in new[] { MobileViewport.Portrait, new ViewportSize { Width = 1366, Height = 900 } })
        {
            await using var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions { ViewportSize = viewport });
            var page = await context.NewPageAsync();
            await using (PlaywrightErrorGuard.Watch(page))
            {
                await page.GotoAsync($"{_fixture.ServerAddress}diag",
                    new PageGotoOptions { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

                await page.Locator("[data-testid='diag-banner']").WaitForAsync(new LocatorWaitForOptions { Timeout = 30_000 });
                (await page.Locator("h1").First.TextContentAsync()).Should().Contain("Status");
                (await page.GetByText("Data", new() { Exact = true }).CountAsync()).Should().BeGreaterThan(0);
                (await page.GetByText("Services", new() { Exact = true }).CountAsync()).Should().BeGreaterThan(0);
                (await page.Locator("[data-testid='diag-version']").InnerTextAsync()).Should().MatchRegex(@"^\d{6}$");
                (await page.Locator(".po-diag__card .po-badge").CountAsync()).Should().BeGreaterThan(1);
                (await page.Locator(".po-header .po-header__title").InnerTextAsync()).Should().Contain("PoMiniGames");
                (await page.Locator(".po-header .po-header__settings").GetAttributeAsync("href")).Should().Be("/settings");
                (await page.Locator(".po-version").InnerTextAsync()).Should().MatchRegex(@"^v\d{6}$");

                // The build stamp: visible, inside the viewport, in the bottom-right quarter.
                var stamp = await page.Locator("[data-testid='build-version']").BoundingBoxAsync();
                stamp.Should().NotBeNull();
                (stamp!.X + stamp.Width).Should().BeLessThanOrEqualTo(viewport.Width);
                (stamp.Y + stamp.Height).Should().BeLessThanOrEqualTo(viewport.Height);
                stamp.X.Should().BeGreaterThan(viewport.Width / 2f);
                stamp.Y.Should().BeGreaterThan(viewport.Height / 2f);

                (await page.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= innerWidth"))
                    .Should().BeTrue("the status page must not scroll sideways at {0}px", viewport.Width);
            }
        }
    }
}
