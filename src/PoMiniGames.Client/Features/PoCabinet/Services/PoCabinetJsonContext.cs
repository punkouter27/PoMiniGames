using System.Text.Json.Serialization;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// Source-generated <see cref="JsonSerializerContext"/> for PoCabinet's localStorage and
/// race.js payloads. Avoids the reflection-based serializer, which the trim analyzer rejects
/// with IL2026.
/// </summary>
[JsonSourceGenerationOptions(
    PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase,
    PropertyNameCaseInsensitive = true,
    UseStringEnumConverter = true)]
[JsonSerializable(typeof(PoCabinetUiSettings))]
// Solo race.js pushes the whole field as JSON on its first and last HUD tick (OnSoloSnapshotJsonAsync).
[JsonSerializable(typeof(PoCabinetRaceSnapshot))]
// Never serialized through this context: the page hands the static world to JS interop, which
// reflects. PoMiniGames.Shared is trimmable, so a property only JS reads (CenterZ, FinishIndex,
// HiddenFrom/To) would lose its getter in a Release publish; naming the type here roots them.
[JsonSerializable(typeof(PoCabinetStaticWorld))]
internal sealed partial class PoCabinetJsonContext : JsonSerializerContext;
