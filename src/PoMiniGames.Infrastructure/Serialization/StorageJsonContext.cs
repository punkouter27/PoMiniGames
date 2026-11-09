using System.Text.Json.Serialization;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Infrastructure.Serialization;

[JsonSourceGenerationOptions(GenerationMode = JsonSourceGenerationMode.Metadata)]
[JsonSerializable(typeof(PlayerStats))]
internal partial class StorageJsonContext : JsonSerializerContext
{
}
