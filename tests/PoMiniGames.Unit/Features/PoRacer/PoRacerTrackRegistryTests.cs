using FluentAssertions;
using PoMiniGames.Features.PoRacer;
using Xunit;

namespace PoMiniGames.Unit.Features.PoRacer;

public class PoRacerTrackRegistryTests
{
    [Theory]
    [InlineData("circuit", 230.0, false)]
    [InlineData("neonskyline", 210.0, false)]
    [InlineData("desertdustway", 255.0, true)]
    [InlineData("crossfire", 180.0, false)]
    [InlineData("unknown_fallback", 230.0, false)]
    public void TrackRegistry_ProvidesValidTrackGeometryAndFallbacks(string trackId, double expectedWidth, bool expectSand)
    {
        var track = PoRacerTrackRegistry.GetTrack(trackId);

        track.Should().NotBeNull();
        if (trackId == "unknown_fallback")
        {
            track.Id.Should().Be("circuit");
        }
        else
        {
            track.Id.Should().Be(trackId);
        }

        track.TrackWidth.Should().Be(expectedWidth);
        track.Centerline.Should().NotBeEmpty();
        track.Centerline.Count.Should().BeGreaterThan(50, "spline resampling should yield continuous nodes");

        // Walls: inside and outside wall segments matching centerline count * 2
        track.Walls.Should().HaveCount(track.Centerline.Count * 2);

        // The knots come from the shared catalog (the client draws its track cards from them).
        track.Centerline[0].Should().Be(new Vec2(PoMiniGames.Shared.Games.PoRacerCatalog.GetTrack(track.Id).Knots[0].X, PoMiniGames.Shared.Games.PoRacerCatalog.GetTrack(track.Id).Knots[0].Y));

        // The day's weather is the one js/weather.js draws for the same track and day (these four
        // were computed with its hash), and only rain and snow cost grip.
        var day = new DateOnly(2026, 11, 14);
        PoMiniGames.Shared.Games.PoRacerWeather.For(track.Id, day).Should().Be(track.Id switch
        {
            "circuit" => "clear",
            "neonskyline" => "rain",
            "desertdustway" => "snow",
            _ => "rain",
        });
        PoMiniGames.Shared.Games.PoRacerWeather.For("crossfire", new DateOnly(2026, 11, 13)).Should().Be("fog");
        PoMiniGames.Shared.Games.PoRacerWeather.Grip("fog").Should().Be(1.0);
        PoMiniGames.Shared.Games.PoRacerWeather.Grip("snow").Should().BeLessThan(PoMiniGames.Shared.Games.PoRacerWeather.Grip("rain")).And.BeGreaterThan(0.5);

        // Sand zones check
        track.HasSandZones.Should().Be(expectSand);

        // Loop continuity: first and last centerline points should connect smoothly
        var first = track.Centerline[0];
        var last = track.Centerline[^1];
        var dx = first.X - last.X;
        var dy = first.Y - last.Y;
        var dist = Math.Sqrt(dx * dx + dy * dy);
        dist.Should().BeLessThan(expectedWidth * 0.75, "closed spline endpoints must connect seamlessly");

        // Partition key calculation for leaderboards
        var partition = PoMiniGames.Infrastructure.Services.StorageService.PoRacerTrackPartition(trackId == "unknown_fallback" ? null : track.Id);
        partition.Should().Be(trackId == "unknown_fallback" ? "poracer_circuit" : $"poracer_{track.Id}");
    }
}
