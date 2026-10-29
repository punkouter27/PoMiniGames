using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Web;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.JSInterop;
using PoMiniGamesClient.Components;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// Every game opens on GameIntro and ends on GameOverModal, so their one-button rule is held
/// here, once, for all of them: the start card's one action is OK, and the end card's is Back
/// to main menu. Rendered to HTML with the framework's static renderer (no browser).
/// </summary>
/// <remarks>
/// The E2E link audit checks the start card of every route live; most games cannot reach their
/// end card cheaply in a browser, so this is where the end card's rule is checked for all of them.
/// </remarks>
public sealed class GameModalButtonTests
{
    [Theory]
    [InlineData(nameof(EndModalHasOnlyBackToMainMenu))]
    [InlineData(nameof(StartCardHasOnlyOk_WhateverTheGamePassesIn))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    private static async Task EndModalHasOnlyBackToMainMenu()
    {
        var html = await RenderAsync<GameOverModal>(new Dictionary<string, object?>
        {
            [nameof(GameOverModal.Title)] = (RenderFragment)(b => b.AddContent(0, "Brawl")),
            [nameof(GameOverModal.GameSummary)] = (RenderFragment)(b => b.AddContent(0, "You win")),
        });

        var buttons = Buttons(html);
        Assert.Single(buttons);
        Assert.Contains("Back to main menu", buttons[0]);
        Assert.Contains("data-end-action", buttons[0]);
    }

    private static async Task StartCardHasOnlyOk_WhateverTheGamePassesIn()
    {
        foreach (var mode in Enum.GetValues<GameIntro.IntroMode>())
        {
            var html = await RenderAsync<GameIntro>(new Dictionary<string, object?>
            {
                [nameof(GameIntro.Mode)] = mode,
                [nameof(GameIntro.Controls)] = (RenderFragment)(b => b.AddMarkupContent(0, "<kbd>W</kbd>")),
                [nameof(GameIntro.Actions)] = (RenderFragment)(b => b.AddMarkupContent(0, "<label><input type=\"checkbox\" /> Training</label>")),
            });

            var actions = Buttons(html).Where(b => b.Contains("data-intro-action")).ToList();
            Assert.Single(actions);
            Assert.Matches(@">\s*OK\s*</button>", actions[0]);
            // Nothing else in the footer acts: the only other buttons a card may carry are the
            // tabs and toggles that switch what it shows (none in this card).
            Assert.Single(Buttons(Footer(html)));
        }
    }

    private static List<string> Buttons(string html) =>
        Regex.Matches(html, @"<button\b.*?</button>", RegexOptions.Singleline).Select(m => m.Value).ToList();

    private static string Footer(string html) =>
        Regex.Match(html, @"<footer class=""gps-intro-actions"">.*?</footer>", RegexOptions.Singleline).Value;

    private static async Task<string> RenderAsync<T>(Dictionary<string, object?> parameters) where T : IComponent
    {
        var services = new ServiceCollection();
        var js = new NoJs();
        services.AddSingleton<IJSRuntime>(js);
        services.AddSingleton<NavigationManager>(new FixedNavigation());
        services.AddSingleton(new UiFeedbackService(js));
        services.AddSingleton(new ScreenFxService(js));
        services.AddSingleton(new OnlineStatusService(js));
        services.AddSingleton(new ApiService(new HttpClient { BaseAddress = new Uri("http://localhost/") }));
        await using var provider = services.BuildServiceProvider();
        await using var renderer = new HtmlRenderer(provider, NullLoggerFactory.Instance);
        return await renderer.Dispatcher.InvokeAsync(async () =>
            (await renderer.RenderComponentAsync<T>(ParameterView.FromDictionary(parameters))).ToHtmlString());
    }

    private sealed class FixedNavigation : NavigationManager
    {
        public FixedNavigation() => Initialize("http://localhost/", "http://localhost/pobrawl/1player");
    }

    private sealed class NoJs : IJSRuntime
    {
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) => ValueTask.FromResult(default(TValue)!);

        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken, object?[]? args) =>
            ValueTask.FromResult(default(TValue)!);
    }
}
