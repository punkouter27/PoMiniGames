using Azure.Security.KeyVault.Secrets;
using FluentAssertions;
using Microsoft.Extensions.Configuration;
using PoMiniGames.Infrastructure;

namespace PoMiniGames.Unit;

/// <summary>Unit tests for <see cref="PrefixKeyVaultSecretManager"/>.</summary>
public sealed class PrefixKeyVaultSecretManagerTests
{
    private readonly PrefixKeyVaultSecretManager _sut = new("PoMiniGames");

    // ─── Load ────────────────────────────────────────────────────────────

    [Theory]
    [InlineData("PoMiniGames--ConnectionStrings--Default", true)] // exact prefix loads
    [InlineData("OtherApp--ConnectionStrings--Default", false)]   // another app's prefix does not
    [InlineData("pominiGAMES--SomeKey", true)]                    // prefix match is case-insensitive
    [InlineData("NoPrefix", false)]                               // no prefix separator at all
    public void Load_AcceptsOnlySecretsWithThePrefix_CaseInsensitively(string secretName, bool expected)
    {
        var props = new SecretProperties(secretName);
        _sut.Load(props).Should().Be(expected);
    }

    // ─── GetKey ──────────────────────────────────────────────────────────

    [Theory]
    // Double-dash becomes the configuration delimiter, one per segment.
    [InlineData("PoMiniGames--ConnectionStrings--Default", "PoMiniGames:ConnectionStrings:Default")]
    // A single segment still yields prefix + key.
    [InlineData("PoMiniGames--ApiKey", "PoMiniGames:ApiKey")]
    // The prefix is preserved in the configuration key (it is the section name).
    [InlineData("PoMiniGames--ApplicationInsights--ConnectionString", "PoMiniGames:ApplicationInsights:ConnectionString")]
    public void GetKey_ReplacesDoubleDashWithDelimiter_AndPreservesPrefix(string secretName, string expectedKeyColonForm)
    {
        var secret = new KeyVaultSecret(secretName, "value");
        var key = _sut.GetKey(secret);
        // Expected values are written with ':' for readability; compare against the
        // real delimiter so the test survives a (theoretical) delimiter change.
        key.Should().Be(expectedKeyColonForm.Replace(":", ConfigurationPath.KeyDelimiter));
        key.Should().StartWith($"PoMiniGames{ConfigurationPath.KeyDelimiter}");
    }
}
