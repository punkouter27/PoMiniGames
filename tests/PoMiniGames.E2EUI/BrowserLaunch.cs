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
            // On Windows, draw on the real GPU (ANGLE over D3D11) instead of SwiftShader: under the software
            // rasteriser the 3D games run at a few frames a second, so engines report ready late and time-budget
            // tests (Ecosystem, Mule) failed on a busy machine. Elsewhere Chromium's defaults stand.
            // Web Audio plays into a fake output (--disable-audio-output): the host PC's audio device sometimes fails
            // under headless Chromium ("The AudioContext encountered an error from the audio device"), and the error
            // guard fails any test on that console error. Tests that set their own Args keep this flag too.
            Args = OperatingSystem.IsWindows()
                ? ["--disable-audio-output", "--use-angle=d3d11", "--ignore-gpu-blocklist"]
                : ["--disable-audio-output"],
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
