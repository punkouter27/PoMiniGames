using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// E2E-UI for PoMule. Two methods (the tier's last two slots): a person playing month 1 with
/// the keyboard and then on a phone-sized touch screen, and an all-AI demo running a whole
/// match. Both speed the renderer's clock up through its debug handle; the rules still run
/// tick by tick. Screenshots land in artifacts/pomule/.
/// </summary>
[Collection(KestrelServerCollection.Name)]
public class PoMuleUiTests
{
    private const int Land = 0, Development = 2, Market = 5, Finished = 7;
    private readonly KestrelServerFixture _fixture;

    public PoMuleUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    private static string Shots()
    {
        var dir = Path.Combine("artifacts", "pomule");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static Task WaitForPhase(IPage page, int phase, int month, float timeoutMs = 120_000) =>
        page.WaitForFunctionAsync(
            $"() => window.__pomule && window.__pomule() && window.__pomule().phase === {phase} && window.__pomule().snap[0] >= {month}",
            null, new PageWaitForFunctionOptions { Timeout = timeoutMs });

    [Fact]
    public async Task OnePlayer_PlaysAMonthWithTheKeyboard_AndGetsTouchControlsOnAPhone()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var origin = _fixture.ServerAddress.TrimEnd('/');
        var shots = Shots();

        // ── Desktop, keyboard ──
        var desktop = await browser.NewContextAsync(new() { ViewportSize = new() { Width = 1280, Height = 720 } });
        var page = await desktop.NewPageAsync();
        var errors = new List<string>();
        page.PageError += (_, err) => errors.Add(err);
        await page.GotoAsync($"{origin}/pomule/1player?autoGuest=1", new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        // Start card: eight species from Radzen's data list, one pick, Start.
        await page.Locator(".pm-species-card").First.WaitForAsync(new() { Timeout = 60_000 });
        (await page.Locator(".pm-species-card").CountAsync()).Should().Be(8);
        await page.Locator(".pm-species-card", new() { HasText = "Zephyr-Flapper" }).ClickAsync();
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "1-start-card.png") });
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync();

        // Land grant: the highlighter sweeps the plots row by row; Space claims the one it is on.
        await WaitForPhase(page, Land, 1);
        await page.WaitForFunctionAsync("() => window.__pomule().snap[10] >= 3", null, new() { Timeout = 30_000 });
        var first = await page.EvaluateAsync<int>("() => window.__pomule().snap[10]");
        await page.WaitForFunctionAsync($"() => window.__pomule().snap[10] > {first}", null, new() { Timeout = 30_000 });
        (await page.EvaluateAsync<int>("() => window.__pomule().snap[10]")).Should().BeInRange(first + 1, first + 4, "it moves along the row a plot at a time");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "2-land-grant.png") });
        await page.Keyboard.PressAsync("Space");
        await page.WaitForFunctionAsync("() => window.__pomule().owner.filter(o => o === 0).length === 1", null, new() { Timeout = 15_000 });
        await page.EvaluateAsync("() => { window.__pomule().speed = 8; }");

        // Development: everyone is on the map at once under one clock.
        await WaitForPhase(page, Development, 1);
        await page.EvaluateAsync("() => { window.__pomule().speed = 1; }");
        (await page.EvaluateAsync<double>("() => window.__pomule().seat(0, 0)")).Should().Be(1600, "the Zephyr-Flapper starts with 1,600 credits");
        (await page.EvaluateAsync<bool>("() => window.__pomule().lo.width === 384"))
            .Should().BeTrue("the whole screen is one 384-pixel-wide picture, the planet included");

        const string positions = "() => window.__pomule().avatars.map(a => [a.x, a.y])";
        var before = await page.EvaluateAsync<double[][]>(positions);
        await page.Keyboard.DownAsync("d");
        await page.WaitForTimeoutAsync(1000);
        await page.Keyboard.UpAsync("d");
        var after = await page.EvaluateAsync<double[][]>(positions);
        var moved = Enumerable.Range(0, 8).Count(i => before[i][0] != after[i][0] || before[i][1] != after[i][1]);
        moved.Should().BeGreaterThanOrEqualTo(6, "all colonists develop at the same time, not in turns");
        after[0][0].Should().NotBe(before[0][0], "the D key walks the player's avatar east");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "3-development.png") });

        // Walk back and up through the town's door: the store's interior takes over the screen.
        await page.Keyboard.DownAsync("a");
        await page.WaitForTimeoutAsync(1000);
        await page.Keyboard.UpAsync("a");
        await page.Keyboard.DownAsync("w");
        await page.WaitForFunctionAsync("() => !!window.__pomule().interior", null, new() { Timeout = 10_000 });
        await page.Keyboard.UpAsync("w");
        // East and down into the corral: walking into the stall buys the M.U.L.E.
        await page.Keyboard.DownAsync("d");
        await page.WaitForFunctionAsync("() => window.__pomule().avatars[0].x > 1270", null, new() { Timeout = 10_000 });
        await page.Keyboard.UpAsync("d");
        await page.Keyboard.DownAsync("s");
        await page.WaitForFunctionAsync("() => window.__pomule().seat(0, 6) === 1", null, new() { Timeout = 10_000 });
        await page.Keyboard.UpAsync("s");
        (await page.EvaluateAsync<double>("() => window.__pomule().seat(0, 0)")).Should().Be(1500, "a M.U.L.E. costs 100");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "3b-store.png") });

        // The rest of the month: production, event, the four markets, standings; then month 2.
        await page.EvaluateAsync("() => { window.__pomule().speed = 8; }");
        await WaitForPhase(page, Market, 1);
        await page.EvaluateAsync("() => { window.__pomule().speed = 1; }");
        await page.Keyboard.DownAsync("w");
        await page.WaitForTimeoutAsync(600);
        await page.Keyboard.UpAsync("w");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "4-market.png") });
        await page.EvaluateAsync("() => { window.__pomule().speed = 8; }");
        await page.Locator(".pm-standings").WaitForAsync(new() { Timeout = 120_000 });
        await page.EvaluateAsync("() => { window.__pomule().speed = 1; }");
        await page.ScreenshotAsync(new() { Path = Path.Combine(shots, "5-standings.png") });
        await page.Keyboard.PressAsync("Space");
        await WaitForPhase(page, Land, 2, 30_000);

        // A reload offers the match back from the start of month 2: Continue is the ticked
        // choice, and OK takes it.
        await page.ReloadAsync(new() { WaitUntil = WaitUntilState.NetworkIdle });
        var resume = page.GetByRole(AriaRole.Radio, new() { Name = "Continue (month 2)" });
        await resume.WaitForAsync(new() { Timeout = 60_000 });
        (await resume.IsCheckedAsync()).Should().BeTrue("a saved match is offered back by default");
        await page.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).ClickAsync();
        await WaitForPhase(page, Land, 2, 30_000);
        (await page.EvaluateAsync<int>("() => window.__pomule().owner.filter(o => o >= 0).length"))
            .Should().BeGreaterThanOrEqualTo(8, "month 1's land is still owned");
        errors.Should().BeEmpty();
        await desktop.CloseAsync();

        // ── Phone in landscape, touch ──
        var phone = await browser.NewContextAsync(new() { ViewportSize = new() { Width = 844, Height = 390 }, HasTouch = true, IsMobile = true });
        var mobile = await phone.NewPageAsync();
        await mobile.GotoAsync($"{origin}/pomule/1player?autoGuest=1", new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });
        await mobile.Locator(".pm-species-card").First.WaitForAsync(new() { Timeout = 60_000 });
        await mobile.GetByRole(AriaRole.Button, new() { Name = "OK", Exact = true }).TapAsync();
        await WaitForPhase(mobile, Land, 1);
        // The Act button claims the lit plot, the same as Space.
        await mobile.WaitForFunctionAsync("() => window.__pomule().snap[10] >= 0", null, new() { Timeout = 30_000 });
        await mobile.Locator(".pm-touch-act").TapAsync();
        await mobile.WaitForFunctionAsync("() => window.__pomule().owner.filter(o => o === 0).length === 1", null, new() { Timeout = 15_000 });
        await mobile.EvaluateAsync("() => { window.__pomule().speed = 8; }");
        await WaitForPhase(mobile, Development, 1);
        await mobile.EvaluateAsync("() => { window.__pomule().speed = 1; }");

        (await mobile.Locator(".pm-stick").IsVisibleAsync()).Should().BeTrue();
        (await mobile.Locator(".pm-touch-act").IsVisibleAsync()).Should().BeTrue();

        // Push the stick right: the avatar walks east, exactly as the D key does.
        var stick = (await mobile.Locator(".pm-stick").BoundingBoxAsync())!;
        var x0 = await mobile.EvaluateAsync<double>("() => window.__pomule().avatars[0].x");
        await mobile.Mouse.MoveAsync(stick.X + stick.Width / 2, stick.Y + stick.Height / 2);
        await mobile.Mouse.DownAsync();
        await mobile.Mouse.MoveAsync(stick.X + stick.Width - 4, stick.Y + stick.Height / 2);
        await mobile.WaitForTimeoutAsync(700);
        await mobile.Mouse.UpAsync();
        (await mobile.EvaluateAsync<double>("() => window.__pomule().avatars[0].x")).Should().NotBe(x0);
        await mobile.ScreenshotAsync(new() { Path = Path.Combine(shots, "6-phone.png") });
        (await mobile.EvaluateAsync<bool>("() => document.documentElement.scrollWidth <= window.innerWidth"))
            .Should().BeTrue("no sideways page scroll on a phone");
    }

    [Fact]
    public async Task Demo_PlaysAWholeMatchByItself_PostsNoScore_AndLeavesNoRadzenStylesBehind()
    {
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var context = await browser.NewContextAsync(new() { ViewportSize = new() { Width = 1280, Height = 720 } });
        var page = await context.NewPageAsync();
        var errors = new List<string>();
        var scorePosts = 0;
        page.Console += (_, msg) => { if (msg.Type is "error") errors.Add(msg.Text); };
        page.PageError += (_, err) => errors.Add(err);
        page.Request += (_, request) => { if (request.Method == "POST" && request.Url.Contains("/api/pomule/")) scorePosts++; };

        var origin = _fixture.ServerAddress.TrimEnd('/');
        await page.GotoAsync($"{origin}/pomule/demo?autoGuest=1", new() { WaitUntil = WaitUntilState.NetworkIdle, Timeout = 60_000 });

        // No input: the demo card times out and eight AI colonists start month 1.
        await WaitForPhase(page, Development, 1);
        (await page.EvaluateAsync<bool>("() => window.__pomule().human")).Should().BeFalse();
        (await page.EvaluateAsync<double>("() => window.__pomule().speed")).Should().Be(4, "a demo runs at four times speed");
        await page.WaitForTimeoutAsync(1500);
        await page.ScreenshotAsync(new() { Path = Path.Combine(Shots(), "7-demo-development.png") });

        // The speed buttons: 1x, 2x, 4x, 8x, 16x.
        (await page.Locator(".pm-bar--speed .rz-button").CountAsync()).Should().Be(5);
        await page.Locator(".pm-bar--speed .rz-button", new() { HasText = "16×" }).ClickAsync();
        await page.WaitForFunctionAsync("() => window.__pomule().speed === 16", null, new() { Timeout = 10_000 });

        // Run the other eleven months faster than a viewer would watch them.
        await page.EvaluateAsync("() => { window.__pomule().speed = 30; }");
        await WaitForPhase(page, Finished, 12, 240_000);
        await page.Locator(".pm-standings").WaitForAsync(new() { Timeout = 10_000 });
        (await page.Locator(".pm-standings").InnerTextAsync()).Should().ContainEquivalentOf("First Founder").And.ContainEquivalentOf("colony");
        (await page.EvaluateAsync<int>("() => window.__pomule().owner.filter(o => o >= 0).length"))
            .Should().BeGreaterThanOrEqualTo(96, "eight colonists claimed a plot in each of twelve months");
        await page.ScreenshotAsync(new() { Path = Path.Combine(Shots(), "8-demo-final.png") });
        scorePosts.Should().Be(0, "a demo never posts a score");
        errors.Should().BeEmpty();

        // Leaving PoMule takes Radzen's global stylesheet with it, so the hub looks as before.
        (await page.Locator("#pomule-radzen-css").CountAsync()).Should().Be(1);
        // (An in-app navigation: a full page load would lose the stylesheet whatever the page did.)
        await page.EvaluateAsync("() => Blazor.navigateTo('/')");
        await page.WaitForFunctionAsync("() => !document.getElementById('pomule-radzen-css')", null, new() { Timeout = 30_000 });
        (await page.EvaluateAsync<bool>("() => !window.__pomule()")).Should().BeTrue("the engine stops when the page goes");
    }
}
