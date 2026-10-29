using Microsoft.Playwright;
using PoMiniGamesClient.Models;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Link audit: every route the hub can send a player to (each mode in
/// <see cref="GameCatalog.All"/>, chip URLs included) plus the main pages, visited in one
/// browser session. Each must render without the router's "Page not found", without the
/// <c>AppErrorBoundary</c> fallback or Blazor's error bar, without a 404 on a same-origin
/// asset, and without a significant layout shift.
/// </summary>
/// <remarks>
/// <para>
/// One test, not one per route: the tier is capped at 25 methods, and the catalogue grows.
/// Every failure is collected and reported together, so one broken route does not hide the
/// next one.
/// </para>
/// <para>
/// Routes are visited by <c>Blazor.navigateTo</c>, the way a hub card launches a game, so the
/// WASM runtime boots once. A page that holds navigation (a game asking to confirm leaving)
/// falls back to a full load.
/// </para>
/// <para>
/// Layout shift is the browser's own <c>layout-shift</c> entries (PerformanceObserver),
/// summed from the moment the route is entered, excluding shifts right after input. The bar
/// is 0.25, the "poor" line of Core Web Vitals, so this flags a page that jumps, not one
/// that settles a few pixels. The main pages are also held to no sideways scroll on a phone.
/// </para>
/// <para>
/// Every game route that opens on a start card (GameIntro, or Voxel Strike's own) is held to
/// the card's two rules, on the phone pass and again on a desktop pass: everything fits with
/// no vertical scroll (the card and its body), and its one action is a single button reading
/// OK. Tabs, radios and toggles inside the card switch what it shows and do not count.
/// </para>
/// </remarks>
[Collection(KestrelServerCollection.Name)]
public class LinkAuditUiTests
{
    private const double MaxLayoutShift = 0.25;
    private const int SettleMs = 1500;

    /// <summary>The desktop pass's viewport: a 1280×720 laptop, the smallest common one.</summary>
    private static readonly ViewportSize Desktop = new() { Width = 1280, Height = 720 };

    /// <summary>
    /// The start card, read in one go (a demo card leaves on its own a moment later): null when
    /// none is up, else what breaks its rules. A card scrolls when its content is taller than
    /// its box; its action is every button in the card that is not a tab, a radio or a toggle.
    /// </summary>
    private const string StartCardProblems = """
        () => {
          const card = document.querySelector('.gps-intro-card');
          if (!card) return null;
          const out = [];
          for (const el of [card, card.querySelector('.gps-intro-body')]) {
            if (el && el.scrollHeight > el.clientHeight + 1)
              out.push(`${el.className.split(' ')[0]} scrolls (${el.scrollHeight}px of content in ${el.clientHeight}px)`);
          }
          const acts = [...card.querySelectorAll('button')].filter(b =>
            !b.matches('[role=tab], [role=radio], [aria-pressed], [aria-checked]') && !b.closest('[role=radiogroup], [role=tablist]'));
          const labels = acts.map(b => b.innerText.trim());
          if (acts.length !== 1 || labels[0] !== 'OK' || !acts[0].hasAttribute('data-intro-action'))
            out.push(`its buttons are [${labels.join(' | ')}], not one OK`);
          return out.join('; ');
        }
        """;
    /// <summary>The non-game pages a player reaches from the shell.</summary>
    private static readonly string[] MainPages = ["/", "/leaderboards", "/profile", "/health", "/pobrawl/hq"];

    private const string ShiftObserver = """
        window.__poShifts = [];
        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (!e.hadRecentInput) window.__poShifts.push({ t: e.startTime, v: e.value });
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch { }
        """;

    private readonly KestrelServerFixture _fixture;

    public LinkAuditUiTests(KestrelServerFixture fixture) => _fixture = fixture;

    private static IEnumerable<string> CatalogRoutes() =>
        GameCatalog.All
            .SelectMany(g => g.Modes)
            .SelectMany(m => new[] { m.Url, m.ChipUrl })
            .OfType<string>();

    [Fact]
    public async Task LinkAudit_EveryCatalogRouteAndMainPage_Renders_WithoutErrors_404s_OrLayoutShift()
    {
        var routes = MainPages.Concat(CatalogRoutes()).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        routes.Should().HaveCountGreaterThan(MainPages.Length, because: "the catalogue lists the game routes");

        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(BrowserLaunch.Options());
        var origin = new Uri(_fixture.ServerAddress);
        var context = await browser.NewContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = MobileViewport.Portrait,
        });
        // The fake-auth headers go to this host only. Set context-wide, they ride on the games'
        // CDN module imports too (three.js from jsDelivr), whose CORS preflight rejects them,
        // and the engine then fails to load for a reason no player would ever hit.
        await context.RouteAsync("**/*", async route =>
        {
            if (new Uri(route.Request.Url).Authority != origin.Authority)
            {
                await route.ContinueAsync();
                return;
            }
            var headers = new Dictionary<string, string>(route.Request.Headers)
            {
                ["X-Fake-User"] = "test-user",
                ["X-Fake-Roles"] = "Player",
            };
            await route.ContinueAsync(new RouteContinueOptions { Headers = headers });
        });
        await context.AddInitScriptAsync(ShiftObserver);
        var page = await context.NewPageAsync();
        page.Dialog += async (_, dialog) => await dialog.AcceptAsync();

        var current = "/";
        var missing = new List<string>();
        page.Response += (_, response) =>
        {
            if (response.Status != 404) return;
            var url = new Uri(response.Url);
            // API and hub 404s are data answers ("no such match"), not broken links.
            if (url.Authority != origin.Authority
                || url.AbsolutePath.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)
                || url.AbsolutePath.StartsWith("/hubs/", StringComparison.OrdinalIgnoreCase))
            {
                return;
            }
            lock (missing) missing.Add($"{current}: 404 {url.PathAndQuery}");
        };

        // Console errors, quoted with an error failure so it says what threw. Each failure
        // quotes the errors logged since the previous route's check, tagged with the route
        // they were logged on: a page's late async work can throw after it was left.
        var consoleErrors = new List<string>();
        var quoted = 0;
        page.Console += (_, msg) =>
        {
            if (msg.Type == "error") lock (consoleErrors) consoleErrors.Add($"[{current}] {msg.Text}");
        };

        string RecentErrors()
        {
            lock (consoleErrors)
            {
                var recent = string.Join(" | ", consoleErrors.Skip(quoted).Take(8));
                quoted = consoleErrors.Count;
                return recent;
            }
        }

        await page.GotoAsync($"{_fixture.ServerAddress}?autoGuest=1", new PageGotoOptions
        {
            WaitUntil = WaitUntilState.NetworkIdle,
            Timeout = 60_000,
        });
        await page.Locator(".home-card").First.WaitForAsync(new LocatorWaitForOptions { Timeout = 60_000 });

        var failures = new List<string>();
        foreach (var route in routes)
        {
            current = route;
            var path = route.Split('?')[0];
            var start = await page.EvaluateAsync<double>("() => performance.now()");
            try
            {
                await page.EvaluateAsync("u => Blazor.navigateTo(u)", route);
                await page.WaitForFunctionAsync("p => location.pathname === p", path,
                    new PageWaitForFunctionOptions { Timeout = 10_000 });
            }
            catch (TimeoutException)
            {
                // The page held navigation; load the route outright. The observer is
                // re-installed by the init script, so shifts count from that load.
                await page.GotoAsync(new Uri(origin, route.TrimStart('/')).ToString(), new PageGotoOptions
                {
                    WaitUntil = WaitUntilState.NetworkIdle,
                    Timeout = 60_000,
                });
                start = 0;
            }
            await page.WaitForTimeoutAsync(SettleMs);

            if (await page.Locator(".app-notfound").CountAsync() > 0)
                failures.Add($"{route}: the router showed \"Page not found\"");
            if (await page.Locator(".app-error-boundary").CountAsync() > 0)
            {
                var detail = await page.Locator(".app-error-boundary").First.InnerTextAsync();
                failures.Add($"{route}: the error boundary caught an exception: {detail.ReplaceLineEndings(" ")} {RecentErrors()}");
            }
            if (await page.Locator("#blazor-error-ui").IsVisibleAsync())
            {
                failures.Add($"{route}: Blazor's unhandled-error bar is showing. {RecentErrors()}");
                // Dismiss it, so the routes after this one are judged on their own.
                await page.EvaluateAsync("() => { const b = document.getElementById('blazor-error-ui'); if (b) b.style.display = 'none'; }");
            }

            RecentErrors();

            var shift = await page.EvaluateAsync<double>(
                "s => (window.__poShifts || []).filter(e => e.t >= s).reduce((a, e) => a + e.v, 0)", start);
            if (shift > MaxLayoutShift)
                failures.Add($"{route}: layout shift {shift:0.000} (limit {MaxLayoutShift})");

            if (MainPages.Contains(route))
            {
                var overflow = await page.EvaluateAsync<int>(
                    "() => document.documentElement.scrollWidth - window.innerWidth");
                if (overflow > 1)
                    failures.Add($"{route}: scrolls sideways by {overflow}px on a {MobileViewport.Portrait.Width}px phone");
            }
            else if (await page.EvaluateAsync<string?>(StartCardProblems) is { Length: > 0 } problems)
            {
                failures.Add($"{route}: on a {MobileViewport.Portrait.Width}px phone the start card {problems}");
            }
        }

        // Desktop pass: the start cards again, on a laptop screen. Most game pages read their
        // mode once, on first mount, so each route is a full load here.
        await page.SetViewportSizeAsync(Desktop.Width, Desktop.Height);
        foreach (var route in routes.Where(r => !MainPages.Contains(r) && !r.Contains("/demo", StringComparison.OrdinalIgnoreCase)))
        {
            current = route;
            await page.GotoAsync(new Uri(origin, route.TrimStart('/')).ToString(), new PageGotoOptions
            {
                WaitUntil = WaitUntilState.NetworkIdle,
                Timeout = 60_000,
            });
            try
            {
                await page.Locator(".gps-intro-card").First.WaitForAsync(new LocatorWaitForOptions { Timeout = 15_000 });
            }
            catch (TimeoutException)
            {
                continue; // no start card on this route
            }
            await page.WaitForTimeoutAsync(SettleMs);
            if (await page.EvaluateAsync<string?>(StartCardProblems) is { Length: > 0 } problems)
                failures.Add($"{route}: at {Desktop.Width}×{Desktop.Height} the start card {problems}");
        }

        lock (missing) failures.AddRange(missing);
        failures.Should().BeEmpty(because: "every route a player can reach must render cleanly; visited {0}", string.Join(", ", routes));
    }
}
