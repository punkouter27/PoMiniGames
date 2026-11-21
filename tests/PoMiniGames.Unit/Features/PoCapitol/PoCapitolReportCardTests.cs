using FluentAssertions;
using PoMiniGames.Features.PoCapitol;
using PoMiniGames.Shared.Games;
using PoMiniGames.Shared.Validation;
using SkiaSharp;

namespace PoMiniGames.Unit;

/// <summary>The PoCapitol report-card request rules and the PNG the server draws from it.</summary>
public sealed class PoCapitolReportCardTests
{
    private static readonly PoCapitolReportCardRequestValidator Validator = new();

    private static PoCapitolReportCardRequest Good() => new()
    {
        Outcome = "breached",
        Role = "raider",
        Mode = "solo",
        Difficulty = "normal",
        Clock = "3:12 pm",
        Minutes = 12.4,
        Standing = 301,
        Police = 22,
        Casualties = 14,
        LowestIntegrity = 18,
        PeakPressure = 6.5,
        Milestones = 3,
        Integrity = Enumerable.Range(0, 120).Select(i => 100f - i * 0.7f).ToArray(),
        Pressure = Enumerable.Range(0, 120).Select(i => i * 0.05f).ToArray(),
        FrontZ = Enumerable.Range(0, 120).Select(i => 100f - i * 0.9f).ToArray(),
    };

    [Fact]
    public void Good_request_is_valid() => Validator.Validate(Good()).IsValid.Should().BeTrue();

    [Fact]
    public void Empty_series_are_valid() =>
        Validator.Validate(new PoCapitolReportCardRequest()).IsValid.Should().BeTrue();

    [Theory]
    [InlineData("role")]
    [InlineData("mode")]
    [InlineData("outcome")]
    [InlineData("count")]
    [InlineData("integrity-value")]
    [InlineData("pressure-nan")]
    [InlineData("front-length")]
    [InlineData("front-null")]
    public void Bad_requests_are_rejected(string what)
    {
        var r = Good();
        switch (what)
        {
            case "role": r.Role = "spectator"; break;
            case "mode": r.Mode = "versus"; break;
            case "outcome": r.Outcome = "<script>"; break;
            case "count": r.Casualties = -1; break;
            case "integrity-value": r.Integrity[3] = 140f; break;
            case "pressure-nan": r.Pressure[0] = float.NaN; break;
            case "front-length": r.FrontZ = new float[PoCapitolReportCardRequest.MaxSamples + 1]; break;
            case "front-null": r.FrontZ = null!; break;
        }
        Validator.Validate(r).IsValid.Should().BeFalse();
    }

    [Fact]
    public void Renderer_draws_a_1200_by_630_png_with_content()
    {
        var png = PoCapitolReportCardRenderer.Render(Good());

        using var bitmap = SKBitmap.Decode(png);
        bitmap.Should().NotBeNull();
        bitmap.Width.Should().Be(1200);
        bitmap.Height.Should().Be(630);
        var colors = new HashSet<uint>();
        for (var y = 0; y < bitmap.Height; y += 7)
            for (var x = 0; x < bitmap.Width; x += 7)
                colors.Add((uint)bitmap.GetPixel(x, y));
        colors.Count.Should().BeGreaterThan(10);
    }

    [Fact]
    public void Renderer_copes_with_empty_series()
    {
        var png = PoCapitolReportCardRenderer.Render(new PoCapitolReportCardRequest());
        using var bitmap = SKBitmap.Decode(png);
        bitmap.Width.Should().Be(1200);
    }

    [Fact]
    public void Route_transform_puts_the_lawn_left_and_the_house_right()
    {
        var m = PoCapitolReportCardRenderer.RouteTransform(new SKRect(0, 0, 1000, 100));
        var lawn = Silk.NET.Maths.Vector2D.Transform(new Silk.NET.Maths.Vector2D<float>(0, 108), m);
        var house = Silk.NET.Maths.Vector2D.Transform(new Silk.NET.Maths.Vector2D<float>(0, -53), m);
        lawn.X.Should().BeApproximately(0, 0.01f);
        house.X.Should().BeApproximately(1000, 0.01f);
        lawn.Y.Should().BeApproximately(50, 0.01f);
    }
}
