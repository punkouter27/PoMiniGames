using System.Text.Json;
using System.Text.Json.Serialization;
using PoMiniGames.Infrastructure;
using PoMiniGames.Features.Account;
using PoMiniGames.Features.Health;
using PoMiniGames.Features.PoCabinet;
using PoMiniGames.Features.PoRacer;

namespace PoMiniGames.Serialization;

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web)]
[JsonSerializable(typeof(ClientErrorReport))]
[JsonSerializable(typeof(HealthCheckResponse))]
[JsonSerializable(typeof(AntiforgeryExtensions.AntiforgeryValidationError))]
[JsonSerializable(typeof(Dictionary<string, string[]>), TypeInfoPropertyName = "QuestionBank")]
[JsonSerializable(typeof(PoRacerVerifiedLap))]
[JsonSerializable(typeof(PoCabinetRaceRegistry.VerifiedLap))]
internal partial class ApiJsonContext : JsonSerializerContext
{
}

[JsonSourceGenerationOptions(JsonSerializerDefaults.Web, WriteIndented = true)]
[JsonSerializable(typeof(PlayerDataExport))]
internal partial class AccountDataJsonContext : JsonSerializerContext
{
}

[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(DiagResponse))]
internal partial class DiagJsonContext : JsonSerializerContext
{
}
