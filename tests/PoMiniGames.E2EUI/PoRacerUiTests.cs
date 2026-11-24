using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

[Collection(KestrelServerCollection.Name)]
public sealed class PoRacerUiTests(KestrelServerFixture fixture)
{
    private static readonly int[] ZeroAllocations = [0, 0, 0];
    [UiTheory]
    [InlineData("circuit")]
    public async Task SoloTimeTrial_CompletesSavesAndShowsTheLapOnTheNextVisit(string track)
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options();
        launch.SlowMo = 0; // Driving samples steering at 20 Hz; human-scale click delays cannot steer.
        await using var browser = await playwright.Chromium.LaunchAsync(launch);
        await using var context = await browser.NewPlayerContextAsync(new() { ViewportSize = new() { Width = 1440, Height = 900 } });
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
        var errors = new List<string>();
        page.PageError += (_, error) => errors.Add(error);
        var driver = new PoRacerDriver(page);
        // Isolate lap timing and persistence from 63-car traffic: the keyboard driver follows the centerline and
        // does not plan overtakes. 5bc1f7f7 took the Rivals / Time trial choice off the start card; the saved
        // preference it wrote (PoRacerPreferences "PoRacer.Mode") still selects the empty track. Full-field input
        // is tested below.
        await context.AddInitScriptAsync("localStorage.setItem('PoRacer.Mode', 'trial')");
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer/1player");
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        // One circuit (owner 5bc1f7f7): the start card has no track dropdown any more.
        (await page.Locator(".gps-intro-map-select").CountAsync()).Should().Be(0);
        var save = page.WaitForResponseAsync(r => r.Url.EndsWith("/api/poracer/scores", StringComparison.Ordinal) && r.Request.Method == "POST", new() { Timeout = 200000 });
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync();
        await page.Locator(".race-countdown").WaitForAsync();
        (await page.Locator("#racerCanvas").EvaluateAsync<bool>("e => e === document.activeElement")).Should().BeTrue();
        await driver.DriveAsync(page, track);
        driver.SawCountdown.Should().BeTrue();
        driver.MovedDuringCountdown.Should().BeFalse();
        var result = driver.Result!;
        var mine = result.Standings.Single(s => s.CarId == driver.LocalId);
        mine.Finished.Should().BeTrue("the keyboard-driven player must cross the line after three actual laps");
        mine.BestLapSeconds.Should().BeGreaterThan(0);
        result.Standings.Where(s => s.Finished).Select(s => s.TotalTimeSeconds).Should().BeInAscendingOrder();
        (await save).Status.Should().Be(201);
        await page.GetByText("Best lap saved to the leaderboard.", new() { Exact = true }).WaitForAsync();
        await page.Locator(".race-results details summary").ClickAsync();
        (await page.Locator(".race-results .local-driver").InnerTextAsync()).Should().NotContain("DNF");
        await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{track}-results.png" });
        // Return to the hub; visiting the racer again opens the start card.
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to main menu" }).ClickAsync();
        await page.WaitForURLAsync(url => new Uri(url).AbsolutePath == "/");
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer/1player");
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        // The lap just driven is kept for the next visit (PoRacerPreferences, the ghost's best lap); the start
        // card no longer lists it beside a track name since 5bc1f7f7 removed the track dropdown.
        var kept = await page.EvaluateAsync<string?>("t => localStorage.getItem('PoRacer.Best.' + t)", track);
        kept.Should().NotBeNullOrEmpty("the best lap is kept for the next visit");
        double.Parse(kept!.Trim('"'), System.Globalization.CultureInfo.InvariantCulture).Should().BeGreaterThan(0);
        driver.Reset();
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync();
        await page.Locator(".race-metrics").WaitForAsync();
        await BackToStartAsync(page);
        errors.Should().BeEmpty();
    }

    [UiFact]
    public async Task SoloRace_UnfinishedPlayerGetsDnfResultsAndCanReturnToHub()
    {
        using var playwright = await Playwright.CreateAsync();
        var launch = BrowserLaunch.Options(); launch.SlowMo = 0;
        await using var browser = await playwright.Chromium.LaunchAsync(launch);
        var page = await (await browser.NewPlayerContextAsync()).NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
        var errors = new List<string>(); page.PageError += (_, error) => errors.Add(error);
        var driver = new PoRacerDriver(page);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer/1player");
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await driver.DriveAsync(page, "dnf", drive: false);
        driver.Result!.Standings.Single(s => s.CarId == driver.LocalId).Finished.Should().BeFalse();
        await page.Locator(".race-results").WaitForAsync();
        await page.Locator(".race-results details summary").ClickAsync();
        (await page.Locator(".race-results .local-driver").InnerTextAsync()).Should().Contain("DNF");
        // The end card's one button.
        (await page.Locator("dialog.gps-modal[open] button").CountAsync()).Should().Be(1);
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to main menu" }).ClickAsync();
        await page.WaitForURLAsync(url => new Uri(url).AbsolutePath == "/");
        errors.Should().BeEmpty();
    }

    [UiFact]
    public async Task Multiplayer_BindsBothPlayersAfterLeavingTheLobby()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var first = await browser.NewPlayerContextAsync();
        await using var second = await browser.NewPlayerContextAsync();
        var host = await first.NewPageAsync();
        await using var hostGuard = PlaywrightErrorGuard.Watch(host);
        var guest = await second.NewPageAsync();
        await using var guestGuard = PlaywrightErrorGuard.Watch(guest);
        var url = $"{fixture.ServerAddress.TrimEnd('/')}/poracer/multi";
        // Each browser opens on the game's card; its button is what takes the lobby seat.
        await host.GotoAsync(url);
        await host.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await host.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).WaitForAsync(new() { Timeout = 60000 });
        await guest.GotoAsync(url);
        await guest.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await guest.GetByRole(AriaRole.Button, new() { Name = "Ready!", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await host.GetByRole(AriaRole.Button, new() { Name = "Start race", Exact = true }).ClickAsync();
        foreach (var page in new[] { host, guest })
        {
            await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
            (await page.Locator(".race-pos small").InnerTextAsync()).Should().Be("/8");
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
            await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
            await page.Keyboard.UpAsync("ArrowUp");
            (await page.Locator(".race-standings .local-driver").CountAsync()).Should().Be(1);
        }
        var hostDriver = await host.Locator(".race-standings .local-driver").GetAttributeAsync("title");
        var guestDriver = await guest.Locator(".race-standings .local-driver").GetAttributeAsync("title");
        hostDriver.Should().NotBe(guestDriver);
    }

    /// <summary>Leave a race the way a player does: the pause menu, then Back to start.</summary>
    private static async Task BackToStartAsync(IPage page)
    {
        await page.GetByRole(AriaRole.Button, new() { Name = "Pause", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "Back to start", Exact = true }).ClickAsync();
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).WaitForAsync();
    }

    [UiTheory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Race_StartsWithOneClick_InputMovesCar_AndNavigationReleasesTheRenderer(bool touch)
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        await using var context = await browser.NewPlayerContextAsync(new()
        {
            ViewportSize = touch ? new() { Width = 390, Height = 844 } : new() { Width = 1280, Height = 900 },
            HasTouch = touch,
        });
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
        var errors = new List<string>();
        page.PageError += (_, error) => errors.Add(error);
        await page.GotoAsync($"{fixture.ServerAddress.TrimEnd('/')}/poracer");
        if (!touch) await VerifyTrackBitmapCacheAsync(page);
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync(new() { Timeout = 60000 });
        await page.Locator(".race-metrics").WaitForAsync(new() { Timeout = 30000 });
        (await page.Locator(".race-pos small").InnerTextAsync()).Should().Be($"/{PoMiniGames.Shared.Games.PoRacerCatalog.SoloCarCount}");
        if (touch)
        {
            var gas = page.Locator("[data-po-input=up]");
            await gas.DispatchEventAsync("pointerdown", new { pointerId = 1, pointerType = "touch", bubbles = true });
        }
        else
        {
            await page.Locator("#racerCanvas").ClickAsync();
            await page.Keyboard.DownAsync("ArrowUp");
        }
        await page.WaitForFunctionAsync("() => [...document.querySelectorAll('.race-metrics span')].some(e => e.textContent.includes('km/h') && parseInt(e.textContent) > 0)", null, new() { Timeout = 10000 });
        if (touch) await page.Locator("[data-po-input=up]").DispatchEventAsync("pointerup", new { pointerId = 1, bubbles = true });
        else await page.Keyboard.UpAsync("ArrowUp");
        await page.ScreenshotAsync(new() { Path = $"artifacts/poracer-{(touch ? "mobile" : "desktop")}.png" });
        // Standings remain on both sizes. The minimap is back as a small canvas that draws one
        // dot a car (js/poracer/fx.js): it rides the desktop frame and is dropped on a phone,
        // where the strip and the standings are the whole screen.
        (await page.Locator(".race-minimap").CountAsync()).Should().Be(1);
        (await page.Locator(".race-minimap").IsVisibleAsync()).Should().Be(!touch);
        (await page.Locator(".race-standings li").CountAsync()).Should().Be(4);
        await BackToStartAsync(page);
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync();
        await page.Locator(".race-metrics").WaitForAsync();
        await BackToStartAsync(page);
        errors.Should().BeEmpty();
        (await page.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= innerWidth")).Should().BeTrue();
    }

    private static async Task VerifyTrackBitmapCacheAsync(IPage page)
    {
        var allocations = await page.EvaluateAsync<int[]>("""
            async () => {
                const renderer = await import('/js/poracer/renderer.js?cache-regression');
                const canvas = document.createElement('canvas');
                canvas.id = 'track-cache-regression';
                document.body.appendChild(canvas);
                const OriginalCanvas = window.OffscreenCanvas;
                let created = 0;
                window.OffscreenCanvas = class extends OriginalCanvas {
                    constructor(w, h) { super(w, h); created++; }
                };
                const result = [];
                try {
                    renderer.mount(canvas.id);
                    renderer.setStatic([0, 0, 1000, 0, 1000, 1000, 0, 1000],
                        210, [], [], [], 'circuit');
                    const cars = [{ x: 0, y: 0, h: 0, v: 0, position: 1,
                        color: '#ffffff', colorDark: '#888888' }];
                    for (const dpr of [0.75, 1, 1.5]) {
                        canvas.width = 300 * dpr; canvas.height = 180 * dpr;
                        renderer.invalidateBitmaps();
                        renderer.draw(cars, 300, 180);
                        const warmed = created;
                        for (let i = 0; i < 5; i++) {
                            cars[0].x += 10;
                            renderer.draw(cars, 300, 180);
                        }
                        renderer.finish(true);
                        renderer.draw(cars, 300, 180);
                        renderer.finish(false);
                        result.push(created - warmed);
                    }
                    return result;
                } finally {
                    renderer.dispose();
                    window.OffscreenCanvas = OriginalCanvas;
                    canvas.remove();
                }
            }
            """);
        allocations.Should().Equal(ZeroAllocations,
            "camera movement and finish zoom must reuse warmed bitmaps at sub-1x, 1x and high DPR");
    }
}
