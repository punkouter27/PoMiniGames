using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.SignalR;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Unit.Features;

/// <summary>
/// The source-generated hub context changes how payloads are serialised, never what goes
/// over the wire: the same options with and without it write the same JSON.
/// </summary>
public sealed class HubJsonContextTests
{
    [Theory]
    [InlineData(nameof(SharedDtosWriteTheSameJsonAsReflection))]
    [InlineData(nameof(UnlistedTypesStillSerialiseAndApplyIsIdempotent))]
    public Task Scenario(string name) => Scenarios.RunAsync(this, name);

    // Same shape as Program.cs / HubConnectionFactory: SignalR's defaults + camelCase enums.
    private static JsonSerializerOptions HubOptions(bool withContext)
    {
        var options = new JsonHubProtocolOptions().PayloadSerializerOptions;
        options.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
        if (withContext) HubJsonContext.Apply(options);
        return options;
    }

    private static void SharedDtosWriteTheSameJsonAsReflection()
    {
        var seat = new TurnMatchSeat("Ana", false, TurnMatchSide.First, true, false);
        var state = new TurnMatchState("m1", 2, [0, 1, 2], 3, TurnMatchSide.Second, TurnMatchStatus.InProgress,
            TurnMatchEndReason.None, new TurnMatchMove(1, 2, TurnMatchSide.First), [4, 5],
            seat, seat with { DisplayName = "Bo", Side = TurnMatchSide.Second }, DateTimeOffset.UnixEpoch);
        var snapshot = new PoCabinetRaceSnapshot
        {
            GameCode = "ABCD",
            ElapsedRaceTime = 12.5,
            LocalCarId = 3,
            Cars = [new PoCabinetCarState { Id = 3, Name = "Car", X = 1.25, Lap = 2, Style = "brawler" }],
            LatestDialogue = new PoCabinetDialogueEvent { OfficialId = "x", Text = "hi", RaceTick = 9 },
        };
        var batch = new PoVoxelStrikeInputBatch
        {
            PlayerNumber = 2,
            Tick = 7,
            Inputs = { new PoVoxelStrikeInput { Forward = true, Yaw = 45.5f, X = 1, Down = true } },
        };

        var reflection = HubOptions(withContext: false);
        var generated = HubOptions(withContext: true);
        foreach (var payload in new object[] { state, snapshot, batch, new LobbyEvent("join", "Ana joined", DateTimeOffset.UnixEpoch) })
        {
            var expected = JsonSerializer.Serialize(payload, payload.GetType(), reflection);
            Assert.Equal(expected, JsonSerializer.Serialize(payload, payload.GetType(), generated));
            Assert.Equal(expected, JsonSerializer.Serialize(JsonSerializer.Deserialize(expected, payload.GetType(), generated), payload.GetType(), generated));
        }
        Assert.Contains("\"turn\":\"second\"", JsonSerializer.Serialize(state, generated));
        Assert.Same(HubJsonContext.Default, generated.TypeInfoResolverChain[0]);
    }

    private sealed record NotInTheContext(string Name, int Count);

    private static void UnlistedTypesStillSerialiseAndApplyIsIdempotent()
    {
        var options = HubOptions(withContext: true);
        var count = options.TypeInfoResolverChain.Count;
        HubJsonContext.Apply(options);
        Assert.Equal(count, options.TypeInfoResolverChain.Count);
        Assert.Equal("{\"name\":\"x\",\"count\":2}", JsonSerializer.Serialize(new NotInTheContext("x", 2), options));
    }
}
