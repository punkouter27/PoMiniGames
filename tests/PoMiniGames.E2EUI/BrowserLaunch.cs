// filepath: tests/E2EUI/BrowserLaunch.cs
using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Shared Chromium launch options for the E2E-UI tier. Headless by default (CI);
/// set the environment variable <c>HEADED=1</c> to watch the browser live, which
/// also adds a small SlowMo so individual actions are visible to a human.
/// </summary>
public static class BrowserLaunch
{
    public static BrowserTypeLaunchOptions Options()
    {
        var headed = Environment.GetEnvironmentVariable("HEADED") == "1";
        return new BrowserTypeLaunchOptions
        {
            Headless = !headed,
            SlowMo = headed ? 300 : 0,
        };
    }
}

/// <summary>Browser contexts for the E2E-UI tier.</summary>
public static class PlayerContext
{
    /// <summary>
    /// A fresh context for a returning player: three initials are already saved in this browser,
    /// so the first-visit initials prompt (which blocks every page until answered) stays shut and
    /// the test sees the page it navigated to. Random letters by default, so two contexts in one
    /// test are two different players on the boards and in the lobbies.
    /// </summary>
    public static async Task<IBrowserContext> NewPlayerContextAsync(
        this IBrowser browser, BrowserNewContextOptions? options = null, string? initials = null)
    {
        var context = await browser.NewContextAsync(options ?? new BrowserNewContextOptions());
        var letters = initials ?? string.Concat(Enumerable.Range(0, 3).Select(_ => (char)('A' + Random.Shared.Next(26))));
        // Before any page script runs, and only if the page has not saved initials of its own.
        await context.AddInitScriptAsync(
            $"if (!localStorage.getItem('pominigames:initials')) localStorage.setItem('pominigames:initials', '{letters}');");
        return context;
    }
}
