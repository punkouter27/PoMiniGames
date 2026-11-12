using System.Text.Json.Serialization;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Infrastructure.Serialization;

[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(PlayerStats))]
internal sealed partial class StorageJsonContext : JsonSerializerContext
{
}
