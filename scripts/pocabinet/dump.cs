#:project ../../src/PoMiniGames.Shared/PoMiniGames.Shared.csproj
#:property JsonSerializerIsReflectionEnabledByDefault=true
#:property PublishAot=false
// Dumps PoCabinetTrackGeometry.BuildStaticWorld(id) exactly as the page hands it to race.js.
// dotnet run dump.cs -- <outDir> <id> [<id> ...]   ("today" = today's daily circuit,
// "daily:N" = N daily circuits from today, written as daily-yyyyMMdd.json)
using System.Globalization;
using System.Text.Json;
using PoMiniGames.Shared.Games;

var outDir = args[0];
Directory.CreateDirectory(outDir);
var opts = new JsonSerializerOptions(JsonSerializerDefaults.Web);
var ids = new List<string>();
foreach (var a in args.Skip(1))
{
    if (a == "today") ids.Add(PoCabinetDailyTrack.TodayId(DateTime.UtcNow));
    else if (a.StartsWith("daily:", StringComparison.Ordinal)) ids.AddRange(Enumerable.Range(0, int.Parse(a[6..], CultureInfo.InvariantCulture)).Select(d => PoCabinetDailyTrack.IdFor(DateOnly.FromDateTime(DateTime.UtcNow).AddDays(d))));
    else ids.Add(a);
}
foreach (var id in ids)
{
    var world = PoCabinetTrackGeometry.BuildStaticWorld(id);
    File.WriteAllText(Path.Combine(outDir, id + ".json"), JsonSerializer.Serialize(world, opts));
    Console.WriteLine($"{id}: {world.CenterXY.Count / 2} samples, theme {world.Theme}, width {world.TrackWidth}, name {world.TrackName}");
}
