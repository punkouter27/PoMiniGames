#:project ../../src/PoMiniGames.Shared/PoMiniGames.Shared.csproj
#:property JsonSerializerIsReflectionEnabledByDefault=true
#:property PublishAot=false
// Dumps PoCabinetTrackGeometry.BuildStaticWorld() exactly as the page hands it to race.js.
// dotnet run dump.cs -- <outDir>     (writes <outDir>/grandprix.json)
using System.Text.Json;
using PoMiniGames.Shared.Games;

var outDir = args[0];
Directory.CreateDirectory(outDir);
var world = PoCabinetTrackGeometry.BuildStaticWorld(PoCabinetTrackGeometry.TrackId);
File.WriteAllText(Path.Combine(outDir, world.TrackId + ".json"), JsonSerializer.Serialize(world, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
Console.WriteLine($"{world.TrackId}: {world.CenterXY.Count / 2} samples, theme {world.Theme}, width {world.TrackWidth}, {world.TotalLaps} laps, name {world.TrackName}");
