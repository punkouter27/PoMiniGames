using FluentAssertions;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoFighter;

namespace PoMiniGames.Unit.Features.PoFighter;

/// <summary>
/// The select screen's rules that are not markup: how the cursor steps along the grid (built-in
/// fighters in roster order, then this browser's Studio fighters, wrapping at both ends) and
/// what a corner's plate says about a fighter.
/// </summary>
public sealed class PoFighterSelectTests
{
    private static readonly PoFighterCustom[] Studio = [new("studio-ab12", "Robo", "data:image/webp;base64,AAAA")];

    [Fact]
    public void TheCursor_StepsInGridOrder_AndWrapsAtBothEnds()
    {
        var ids = PoFighterRoster.Fighters.Select(f => f.Id).Append(Studio[0].Id).ToArray();

        var walk = new List<string?> { ids[0] };
        for (var i = 0; i < ids.Length; i++) walk.Add(PoFighterSelect.Step(walk[^1], 1, Studio));
        walk.Should().Equal([.. ids, ids[0]], because: "Right walks every tile once and comes back to the first");

        PoFighterSelect.Step(ids[0], -1, Studio).Should().Be(ids[^1], because: "Left from the first tile wraps to the last");
        PoFighterSelect.Step("P1", 1, null).Should().Be(ids[1], because: "ids compare without case, and no Studio list is an empty one");
        PoFighterSelect.Step("gone", 1, Studio).Should().Be(ids[0], because: "a pick that left the grid starts over at the first tile");
    }

    [Fact]
    public void ACorner_NamesTheFighter_ItsArt_AndItsRating()
    {
        var ratings = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase) { ["kim"] = 1016 };

        PoFighterSelect.SideFor("KIM", "CPU", ratings, Studio).Should().Be(
            new PoFighterSide("Kim", "CPU", "data/pofighter/kim-select.webp", "Elo 1016"),
            because: "the name comes from the roster and the art path uses the canonical id");
        PoFighterSelect.SideFor("matt", "1P", ratings, Studio)!.Note.Should().Be("Unrated", because: "a fighter with no bout is not on the board");
        PoFighterSelect.SideFor("studio-ab12", "1P", ratings, Studio).Should().Be(
            new PoFighterSide("Robo", "1P", Studio[0].Portrait, "Studio"),
            because: "a Studio fighter has only its small portrait and is never rated");
        PoFighterSelect.SideFor("nobody", "1P", ratings, Studio).Should().BeNull();
        PoFighterSelect.SideFor(null, "1P", ratings, Studio).Should().BeNull();
    }

    [Fact]
    public void EveryRosterFighter_ShipsItsSheet_ItsData_AndBothSelectPictures()
    {
        var data = Path.Combine(RepoRoot(), "src", "PoMiniGames.Client", "wwwroot", "data", "pofighter");
        foreach (var f in PoFighterRoster.Fighters)
        {
            foreach (var file in new[] { $"{f.Id}.json", $"{f.Id}.webp", $"{f.Id}-portrait.webp", $"{f.Id}-select.webp" })
                File.Exists(Path.Combine(data, file)).Should().BeTrue($"{f.Name} needs {file}: the game loads every roster fighter and the select screen shows both pictures");
        }
    }

    private static string RepoRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        while (dir is not null && !File.Exists(Path.Combine(dir.FullName, "PoMiniGames.slnx"))) dir = dir.Parent;
        return dir?.FullName ?? throw new InvalidOperationException("PoMiniGames.slnx not found above the test folder.");
    }
}
