using FluentAssertions;
using PoMiniGames.Features.PoEcosystem;
using PoMiniGames.Shared.Games.PoEcosystem;
using PoMiniGamesClient.Features.PoEcosystem.Models;

namespace PoMiniGames.Unit.Features.PoEcosystem;

/// <summary>
/// The island's pure edges, one theory because the Unit tier sits at its ceiling: the wire
/// contracts, how a wager is settled from the island's per-year
/// rows, and when a watch alert fires. All of it only ever reads what the sim reports — the
/// island is observed, never steered — so "what the page concludes from the numbers" is all
/// there is to test.
/// </summary>
public sealed class PoEcosystemPureEdgesTests
{
    [Theory]
    [InlineData("contracts")]
    [InlineData("wager")]
    [InlineData("alerts")]
    public void Ecosystem_PureEdges_HoldTheirContracts(string edge)
    {
        switch (edge)
        {
            case "contracts":
                {
                    // Multi-tribe telemetry and building contracts serialize cleanly with the source-generated context
                    var tribe = new TribeStateDto(
                        Id: 0,
                        Name: "Amber Clan",
                        BannerColor: "#d48806",
                        Tech: TechTier.Primitive,
                        Population: 8,
                        Warriors: 2,
                        Wood: 50,
                        Stone: 20,
                        Food: 120,
                        CenterX: 10.5f,
                        CenterZ: 15.2f,
                        TerritoryRadius: 28.0f,
                        Relations: [0, 1, 2]);

                    var building = new BuildingStateDto(
                        Id: 1,
                        TribeId: 0,
                        Kind: BuildingKind.Hut,
                        X: 12.0f,
                        Z: 14.5f,
                        Progress: 1.0f,
                        Health: 100.0f,
                        IsComplete: true);

                    var telemetry = new EcosystemTelemetryDeltaDto(
                        Year: 3,
                        Day: 4,
                        Tick: 1200,
                        Tribes: [tribe],
                        Buildings: [building],
                        RabbitCount: 35,
                        WolfCount: 5,
                        TotalHumanCount: 8,
                        IsYearMilestone: false);

                    var json = System.Text.Json.JsonSerializer.Serialize(telemetry, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    json.Should().NotBeNullOrWhiteSpace();

                    var restored = System.Text.Json.JsonSerializer.Deserialize(json, PoEcosystemJsonContext.Default.EcosystemTelemetryDeltaDto);
                    restored.Should().NotBeNull();
                    restored!.Tribes.Should().HaveCount(1);
                    restored.Tribes[0].Name.Should().Be("Amber Clan");
                    restored.Tribes[0].Tech.Should().Be(TechTier.Primitive);
                    restored.Buildings.Should().HaveCount(1);
                    restored.Buildings[0].Kind.Should().Be(BuildingKind.Hut);
                    break;
                }
            case "wager":
                {
                    // Rows are [year, rabbits, deer, wolves, humans, tech, H'×1000], one per year.
                    static int[][] Years(int to, Func<int, int[]> row) => Enumerable.Range(0, to + 1).Select(y => new[] { y }.Concat(row(y)).ToArray()).ToArray();
                    var extinct = EcoWagers.All.Single(q => q.Id == "extinct");
                    var alive = EcoWagers.All.Single(q => q.Id == "alive10");
                    var tech = EcoWagers.All.Single(q => q.Id == "tech20");

                    // Wolves die out in year 7: settled the moment the row says so, long before year 30.
                    var wolvesGone = Years(12, y => [40 + y, 20, y >= 7 ? 0 : 6, 18, Math.Min(4, y / 5), 900]);
                    EcoWagers.Outcome(extinct, wolvesGone).Should().Be(2);
                    EcoWagers.Outcome(alive, wolvesGone).Should().Be(0, "50 + 20 + 0 + 18 = 88 at year 10 is under 100");
                    EcoWagers.Outcome(tech, wolvesGone).Should().BeNull("year 20 has not been lived yet");

                    // Nobody dies out: unknown until year 30, then "none of them".
                    EcoWagers.Outcome(extinct, Years(29, _ => [100, 60, 12, 30, 2, 900])).Should().BeNull();
                    var thriving = Years(30, _ => [100, 60, 12, 30, 2, 900]);
                    EcoWagers.Outcome(extinct, thriving).Should().Be(4);
                    EcoWagers.Outcome(alive, thriving).Should().Be(2, "202 alive is the 175–249 bucket");
                    EcoWagers.Outcome(tech, thriving).Should().Be(2);
                    EcoWagers.Outcome(extinct, []).Should().BeNull();

                    // The book scores each bet once, however often the history is re-sent.
                    var book = new EcoWagerBook();
                    book.Open(seed: 99);
                    book.Pick("extinct", 4);
                    book.Pick("alive10", 0);
                    var before = (book.Record.Points, book.Record.Right, book.Record.Settled);
                    book.Settle(thriving).Should().HaveCount(2);
                    book.Settle(thriving).Should().BeEmpty("a settled bet is not scored twice");
                    (book.Record.Points - before.Points).Should().Be(extinct.Points, "one right, one wrong");
                    (book.Record.Right - before.Right).Should().Be(1);
                    (book.Record.Settled - before.Settled).Should().Be(2);
                    break;
                }
            case "alerts":
                {
                    static EcoStats Stats(int wolves) => new(
                        Tick: 1, Speed: 1, Year: 1, Day: 1, DayFraction: 0.5, Alive: 60 + wolves, Huts: 3,
                        Counts: [40, 20, wolves, 0], Extinct: [false, false, false, false], LastStanding: -1, Silent: false,
                        Carcasses: 0, SimLag: 0, PopHistory: [],
                        NaturalEvents: new EcoNaturalEvents(0, 0, 0));

                    var rule = new EcoAlertRule(Species: 2, Below: true, Value: 5);
                    rule.Describe().Should().Be("Wolves below 5");
                    rule.Holds(Stats(4)).Should().BeTrue();
                    rule.Holds(Stats(5)).Should().BeFalse();
                    new EcoAlertRule(-1, Below: false, Value: 64).Holds(Stats(5)).Should().BeTrue("65 creatures alive is above 64");

                    // An alert is an edge, not a level: once when it starts to hold, again only
                    // after it has stopped holding — and never for the state a world opens in.
                    var book = new EcoAlertBook();
                    foreach (var old in book.Rules.ToArray()) book.Remove(old);
                    book.Add(rule).Should().BeTrue();
                    book.Add(rule).Should().BeFalse("the same rule twice is one rule");
                    book.ResetWorld();
                    book.Observe(Stats(3)).Should().BeEmpty("what holds on a world's first message is not news");
                    book.Observe(Stats(8)).Should().BeEmpty();
                    book.Observe(Stats(4)).Should().ContainSingle();
                    book.Observe(Stats(2)).Should().BeEmpty("still holding");
                    book.Observe(Stats(9)).Should().BeEmpty();
                    book.Observe(Stats(1)).Should().ContainSingle("it re-armed when the wolves recovered");
                    break;
                }
        }
    }
}
