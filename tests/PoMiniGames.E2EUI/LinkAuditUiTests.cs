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
          if (card.querySelector('.mode-switch, [role="tablist"][aria-label="Mode"]'))
            out.push('repeats main-menu mode selection');
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
    /// <summary>
    /// Every visible control smaller than a 44px thumb target (Profile B), as "selector WxH" lines.
    /// Inline links inside running text are exempt (WCAG 2.5.8's inline exception), as is anything
    /// marked data-tap-exempt (a control that is not for touch, e.g. a desktop-only hint).
    /// </summary>
    private const string SmallTapTargets = """
        () => {
          const out = [];
          for (const el of document.querySelectorAll('button, a[href], [role=button], [role=tab], select, summary, input:not([type=hidden])')) {
            const st = getComputedStyle(el), b = el.getBoundingClientRect();
            if (st.visibility === 'hidden' || st.display === 'none' || b.width === 0 || b.height === 0) continue;
            if (b.bottom < 0 || b.top > innerHeight || b.right < 0 || b.left > innerWidth) continue;
            if (el.closest('[data-tap-exempt], [inert], [aria-hidden=true]')) continue;
            if (el.tagName === 'A' && st.display === 'inline') continue;
            if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label')) continue;
            // Layout size, not the painted box: a card still in its pop-in animation is scaled.
            const w = el.offsetWidth ?? b.width, h = el.offsetHeight ?? b.height;
            if (w + 0.5 >= 44 && h + 0.5 >= 44) continue;
            const cls = (el.className && el.className.baseVal === undefined ? el.className : '').split(' ').filter(Boolean)[0];
            out.push(`${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} ${Math.round(w)}x${Math.round(h)}`);
          }
          return [...new Set(out)].slice(0, 6).join(', ');
        }
        """;

    /// <summary>The end card, read like the start card: its one action and no scrolling.</summary>
    private const string EndCardProblems = """
        () => {
          const card = document.querySelector('dialog.gps-modal[open]');
          if (!card) return 'is not up';
          const out = [];
          if (card.scrollHeight > card.clientHeight + 1)
            out.push(`scrolls (${card.scrollHeight}px of content in ${card.clientHeight}px)`);
          const acts = [...card.querySelectorAll('button')].filter(b => !b.closest('details, summary'));
          const labels = acts.map(b => b.innerText.replace(/\s+/g, ' ').replace(/ Esc$/, '').trim());
          if (acts.length !== 1 || labels[0] !== 'Back to main menu' || !acts[0].hasAttribute('data-end-action'))
            out.push(`its buttons are [${labels.join(' | ')}], not one "Back to main menu"`);
          return out.join('; ');
        }
        """;

    /// <summary>The non-game pages a player reaches from the shell.</summary>
    private static readonly string[] MainPages = ["/", "/leaderboards", "/profile", "/diag", "/health", "/pobrawl/hq"];

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
        // The phone pass runs on the small phone, as a touch device (coarse pointer), so the
        // start cards and the 44px floor are judged where they are tightest.
        var phone = MobileViewport.SmallPortrait;
        var context = await browser.NewPlayerContextAsync(new BrowserNewContextOptions
        {
            ViewportSize = phone,
            HasTouch = true,
            IsMobile = true,
        });
        // The fake-auth headers go to this host only. Set context-wide, they ride on the games'
        // CDN module imports too (three.js from jsDelivr), whose CORS preflight rejects them,
        // and the engine then fails to load for a reason no player would ever hit.
        await context.AddInitScriptAsync(ShiftObserver);
        var page = await context.NewPageAsync();
        await using var guard = PlaywrightErrorGuard.Watch(page);
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

        await page.GotoAsync($"{_fixture.ServerAddress}", new PageGotoOptions
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
                    failures.Add($"{route}: scrolls sideways by {overflow}px on a {phone.Width}px phone");
            }
            else if (await page.EvaluateAsync<string?>(StartCardProblems) is { Length: > 0 } problems)
            {
                failures.Add($"{route}: on a {phone.Width}×{phone.Height} phone the start card {problems}");
            }
            if (await page.EvaluateAsync<string>(SmallTapTargets) is { Length: > 0 } small)
                failures.Add($"{route}: touch targets under 44px on a phone: {small}");
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
            var intro = page.Locator("dialog.gps-intro-overlay[open]");
            if (await intro.CountAsync() > 0)
            {
                var buttons = intro.Locator("button:enabled");
                if (await buttons.CountAsync() > 0)
                {
                    await buttons.Last.FocusAsync();
                    await page.Keyboard.PressAsync("Tab");
                    if (!await intro.EvaluateAsync<bool>("el => el.contains(document.activeElement)"))
                        failures.Add($"{route}: Tab escaped the intro");
                    await buttons.First.FocusAsync();
                    await page.Keyboard.PressAsync("Shift+Tab");
                    if (!await intro.EvaluateAsync<bool>("el => el.contains(document.activeElement)"))
                        failures.Add($"{route}: Shift+Tab escaped the intro");
                    await buttons.First.FocusAsync();
                    await page.Keyboard.PressAsync("Escape");
                    try
                    {
                        await page.WaitForURLAsync(origin.ToString(), new PageWaitForURLOptions { Timeout = 5_000 });
                    }
                    catch (TimeoutException)
                    {
                        failures.Add($"{route}: Escape did not cancel the intro");
                    }
                }
            }
        }

        // The end card, on the small phone where it is tightest: the shared GameOverModal every
        // game ends on, so one game's result card stands for the component.
        current = "/tictactoe/2player";
        await page.SetViewportSizeAsync(phone.Width, phone.Height);
        await page.GotoAsync(new Uri(origin, current).ToString());
        await page.Locator("dialog[open] [data-intro-action]").ClickAsync();
        var cells = page.GetByRole(AriaRole.Gridcell);
        foreach (var index in new[] { 0, 6, 1, 7, 2, 8, 3 })
            await cells.Nth(index).ClickAsync();
        var result = page.Locator("dialog.gps-modal[open]");
        await result.WaitForAsync(new LocatorWaitForOptions { Timeout = 15_000 });
        await page.WaitForTimeoutAsync(SettleMs);
        if (await page.EvaluateAsync<string>(EndCardProblems) is { Length: > 0 } endProblems)
            failures.Add($"Tic-Tac-Toe result on a {phone.Width}×{phone.Height} phone: the end card {endProblems}");
        await result.Locator("[data-end-action]").FocusAsync();
        await page.Keyboard.PressAsync("Tab");
        if (!await result.EvaluateAsync<bool>("el => el.contains(document.activeElement)"))
            failures.Add("Tic-Tac-Toe result: Tab escaped the dialog");
        await page.Keyboard.PressAsync("Escape");
        try
        {
            await page.WaitForURLAsync(origin.ToString(), new PageWaitForURLOptions { Timeout = 5_000 });
        }
        catch (TimeoutException)
        {
            failures.Add("Tic-Tac-Toe result: Escape did not return home");
        }

        lock (missing) failures.AddRange(missing);
        failures.Should().BeEmpty(because: "every route a player can reach must render cleanly; visited {0}", string.Join(", ", routes));
    }
}
