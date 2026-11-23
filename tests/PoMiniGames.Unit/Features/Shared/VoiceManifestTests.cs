using System.Text.Json;
using FluentAssertions;
using PoMiniGames.Domain.Primitives;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features.Shared;

/// <summary>
/// The per-game voice manifests (<c>wwwroot/audio/&lt;game&gt;/voices.json</c>, written by
/// <c>scripts/pofighter/voices.ps1</c>): every roster character × 5 emotions × 5 levels with its
/// WAV path and <c>exists</c> flag, and a distinct procedural voice profile per character.
/// </summary>
public sealed class VoiceManifestTests
{
    private static readonly string[] Emotions = ["angry", "happy", "hurt", "insult", "celebrate"];

    public static TheoryData<string> Games => new() { "pobrawl", "pofighter" };

    private static string[] RosterOf(string game) => game switch
    {
        "pobrawl" => [.. PoBrawlRoster.Fighters.Select(f => f.Id), PoBrawlRoster.Bob.Id],
        "pofighter" => [.. PoFighterRoster.Fighters.Select(f => f.Id)],
        _ => throw new ArgumentOutOfRangeException(nameof(game)),
    };

    [Theory]
    [MemberData(nameof(Games))]
    public void Manifest_ListsEveryCharacter_EveryCell_AndADistinctVoice(string game)
    {
        using var doc = JsonDocument.Parse(File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "VoiceManifests", game, "voices.json")));
        var root = doc.RootElement;
        root.GetProperty("schema").GetString().Should().Be("po-voice-manifest/1");
        root.GetProperty("game").GetString().Should().Be(game);
        root.GetProperty("fallback").GetString().Should().Be("procedural");
        root.GetProperty("emotions").EnumerateArray().Select(e => e.GetString()).Should().Equal(Emotions);
        root.GetProperty("levels").EnumerateArray().Select(e => e.GetInt32()).Should().Equal(1, 2, 3, 4, 5);

        var characters = root.GetProperty("characters").EnumerateArray().ToArray();
        characters.Select(c => c.GetProperty("id").GetString()).Should().BeEquivalentTo(RosterOf(game),
            because: "every roster character has a voice set, and BYE slots are not characters");

        var voices = new HashSet<(double, double)>();
        foreach (var c in characters)
        {
            var id = c.GetProperty("id").GetString()!;
            id.Should().Be(id.ToLowerInvariant());
            c.GetProperty("name").GetString().Should().NotBeNullOrWhiteSpace();
            var voice = c.GetProperty("voice");
            voice.GetProperty("pitchHz").GetDouble().Should().BeInRange(60, 400, because: $"{id} needs a speaking pitch");
            voice.GetProperty("formantScale").GetDouble().Should().BeInRange(0.7, 1.5);
            foreach (var knob in new[] { "breath", "rasp", "vibratoHz", "vibratoDepth", "tempo" })
                voice.TryGetProperty(knob, out _).Should().BeTrue(because: $"{id}'s profile sets {knob}");
            voice.GetProperty("timbre").GetString().Should().NotBeNullOrWhiteSpace();
            voices.Add((voice.GetProperty("pitchHz").GetDouble(), voice.GetProperty("formantScale").GetDouble()))
                .Should().BeTrue(because: $"{id} must not sound like another character");

            var clips = c.GetProperty("clips");
            clips.EnumerateObject().Select(p => p.Name).Should().Equal(Emotions);
            foreach (var emotion in Emotions)
            {
                var cells = clips.GetProperty(emotion).EnumerateArray().ToArray();
                cells.Select(x => x.GetProperty("level").GetInt32()).Should().Equal(1, 2, 3, 4, 5);
                foreach (var cell in cells)
                {
                    var level = cell.GetProperty("level").GetInt32();
                    cell.GetProperty("file").GetString().Should().Be($"{id}/{emotion}-{level}.wav");
                    cell.GetProperty("exists").ValueKind.Should().BeOneOf(JsonValueKind.True, JsonValueKind.False);
                }
            }
        }
    }
}
