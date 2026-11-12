using FluentAssertions;
using Microsoft.JSInterop;
using PoMiniGamesClient.Services.Play;
using Xunit;

namespace PoMiniGames.Integration.Features.PoRacer;

public sealed class PoRacerPendingScoreTests
{
    [Fact]
    public void PendingScores_SurviveSerialization_AndCanBeRemovedAfterSync()
    {
        var browser = new BrowserStorage();
        LocalStorageService.SetJSRuntime(browser);
        try
        {
            var store = new PendingScoreStore();
            store.Save([new() { Kind = PendingScoreKind.PoRacer, PayloadJson = "{\"totalTimeSeconds\":42.125}", Attempts = 2 }]);
            browser.Values.Should().ContainKey("pominigames:pending-scores");
            var restored = new PendingScoreStore().Load().Should().ContainSingle().Subject;
            restored.Kind.Should().Be(PendingScoreKind.PoRacer);
            restored.PayloadJson.Should().Contain("42.125");
            restored.Attempts.Should().Be(2);
            store.Save([]);
            new PendingScoreStore().Load().Should().BeEmpty();
        }
        finally { LocalStorageService.SetJSRuntime(null!); }
    }

    private sealed class BrowserStorage : IJSInProcessRuntime
    {
        public Dictionary<string, string> Values { get; } = [];
        public TValue Invoke<TValue>(string identifier, params object?[]? args)
        {
            if (identifier.EndsWith("setItem", StringComparison.Ordinal)) Values[(string)args![0]!] = (string)args[1]!;
            return identifier.EndsWith("getItem", StringComparison.Ordinal)
                ? (TValue)(object?)Values.GetValueOrDefault((string)args![0]!)! : default!;
        }
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, object?[]? args) => new(Invoke<TValue>(identifier, args));
        public ValueTask<TValue> InvokeAsync<TValue>(string identifier, CancellationToken cancellationToken, object?[]? args) => new(Invoke<TValue>(identifier, args));
    }
}
