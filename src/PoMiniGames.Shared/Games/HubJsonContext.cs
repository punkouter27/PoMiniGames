using System.Diagnostics.CodeAnalysis;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace PoMiniGames.Shared.Games;

/// <summary>
/// Source-generated metadata for the SignalR hub payloads that live in Shared, so the
/// hot hub messages (race snapshots, lockstep frames, match state) skip reflection on
/// both the server and the trimmed WASM client.
/// </summary>
/// <remarks>
/// <see cref="Apply"/> puts this context at the front of the hub protocol's resolver chain
/// and keeps the default (reflection) resolver behind it, so a payload not listed here
/// (the quiz hubs' API/Client-only records, ad-hoc tuples) still serialises as before.
/// Naming policy, case-insensitivity and the camelCase <see cref="JsonStringEnumConverter"/>
/// come from the hub's runtime options, not from this context, so the wire format is
/// unchanged. When a hub gains a new Shared DTO, add it here.
/// </remarks>
// Lobby (Racer, VoxelStrike, Brawl online)
[JsonSerializable(typeof(LobbyState<PoRacerLobbyPlayer>))]
[JsonSerializable(typeof(LobbyState<PoVoxelStrikeLobbyPlayer>))]
[JsonSerializable(typeof(LobbyState<PoBrawlLobbyPlayer>))]
[JsonSerializable(typeof(LobbyEvent))]
// Turn match (ConnectFive, TicTacToe)
[JsonSerializable(typeof(TurnMatchStart))]
[JsonSerializable(typeof(TurnMatchState))]
[JsonSerializable(typeof(TurnMatchQueueStatus))]
[JsonSerializable(typeof(TurnMatchRejoinResult))]
// PoBrawl online
[JsonSerializable(typeof(PoBrawlMatchSnapshot))]
[JsonSerializable(typeof(PoBrawlMatchState))]
[JsonSerializable(typeof(PoBrawlMatchInput))]
[JsonSerializable(typeof(PoBrawlMatchInputEvent))]
[JsonSerializable(typeof(PoBrawlMatchResult))]
[JsonSerializable(typeof(PoBrawlMatchClock))]
// PoCabinet lobby + race
[JsonSerializable(typeof(PoCabinetLobbyView))]
[JsonSerializable(typeof(PoCabinetRaceSnapshot))]
[JsonSerializable(typeof(PoCabinetFinalResult))]
[JsonSerializable(typeof(PoCabinetInput))]
// PoMarbleRace online
[JsonSerializable(typeof(MarbleRaceQueueStatus))]
[JsonSerializable(typeof(MarbleRaceStart))]
[JsonSerializable(typeof(MarbleRaceFrame))]
[JsonSerializable(typeof(MarbleRacePhase))]
[JsonSerializable(typeof(MarbleRacePodium))]
[JsonSerializable(typeof(MarbleRaceResult))]
// PoRacer
[JsonSerializable(typeof(PoRacerRaceSnapshot))]
[JsonSerializable(typeof(PoRacerFinalResult))]
[JsonSerializable(typeof(PoRacerInput))]
[JsonSerializable(typeof(PoRacerJoinOptions))]
[JsonSerializable(typeof(List<PoRacerCarInfo>))]
// PoVoxelStrike lockstep
[JsonSerializable(typeof(PoVoxelStrikeLockstepSessionInfo))]
[JsonSerializable(typeof(PoVoxelStrikeLockstepFrame))]
[JsonSerializable(typeof(PoVoxelStrikeInputBatch))]
[JsonSerializable(typeof(PoVoxelStrikeClientHeartbeat))]
// Primitive hub arguments
[JsonSerializable(typeof(string))]
[JsonSerializable(typeof(int))]
[JsonSerializable(typeof(long))]
[JsonSerializable(typeof(bool))]
[JsonSerializable(typeof(float))]
[JsonSerializable(typeof(byte[]))]
public sealed partial class HubJsonContext : JsonSerializerContext
{
    /// <summary>
    /// Puts <see cref="HubJsonContext"/> first in <paramref name="options"/>' resolver chain,
    /// keeping whatever resolver was there (or the default one) as the fallback.
    /// Idempotent: a second call leaves the chain alone.
    /// </summary>
    [UnconditionalSuppressMessage("Trimming", "IL2026",
        Justification = "The reflection fallback is what every hub payload used before this context existed; types listed here never reach it.")]
    [UnconditionalSuppressMessage("AOT", "IL3050",
        Justification = "Same fallback as above; the app is not published native-AOT.")]
    public static void Apply(JsonSerializerOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        var chain = options.TypeInfoResolverChain;
        if (chain.Contains(Default)) return;
        // An options instance with no resolver yet falls back to the default resolver lazily;
        // once the chain is non-empty that implicit fallback is gone, so add it explicitly.
        var hadResolver = chain.Count > 0;
        chain.Insert(0, Default);
        if (!hadResolver && JsonSerializer.IsReflectionEnabledByDefault)
        {
            chain.Add(new DefaultJsonTypeInfoResolver());
        }
    }
}
