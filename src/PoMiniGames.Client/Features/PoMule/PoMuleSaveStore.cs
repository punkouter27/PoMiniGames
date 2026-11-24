using PoMiniGames.Shared.Games.PoMule;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Features.PoMule;

/// <summary>
/// The one match in progress, kept in the browser between months so a reload or a closed tab
/// does not throw away twenty minutes of play.
/// </summary>
/// <remarks>
/// String API only: trim-safe and swallows storage unavailability (private mode) so the
/// match plays on without resuming across reloads.
/// </remarks>
public sealed class PoMuleSaveStore(IBrowserStorage storage)
{
    private const string LegacyKey = "pomule.save.v1";

    private static string KeyFor(string? initials)
    {
        var clean = string.IsNullOrWhiteSpace(initials) ? "_" : initials.Trim().ToUpperInvariant();
        return $"{LegacyKey}.{clean}";
    }

    /// <summary>The saved match for <paramref name="initials"/>, or null when there is none or it is finished.</summary>
    public async Task<MatchState?> LoadAsync(string? initials)
    {
        var key = KeyFor(initials);
        try
        {
            var raw = await storage.GetItemAsStringAsync(key);
            if (!string.IsNullOrEmpty(raw))
            {
                var state = PoMuleSave.FromJson(raw);
                // A finished match has nothing left to continue.
                return state is { Phase: not Phase.Finished } ? state : null;
            }

            // Migrate a legacy single-slot save if it belongs to these initials.
            var legacyRaw = await storage.GetItemAsStringAsync(LegacyKey);
            if (!string.IsNullOrEmpty(legacyRaw))
            {
                var legacy = PoMuleSave.FromJson(legacyRaw);
                if (legacy is { Phase: not Phase.Finished })
                {
                    var savedName = legacy.Players.Length > 0 ? legacy.Players[0].Name?.Trim() : null;
                    var clean = initials?.Trim();
                    if (string.IsNullOrEmpty(clean) || string.Equals(savedName, clean, StringComparison.OrdinalIgnoreCase))
                    {
                        await storage.SetItemAsStringAsync(key, legacyRaw);
                        await storage.RemoveItemAsync(LegacyKey);
                        return legacy;
                    }
                }
            }
            return null;
        }
        catch
        {
            return null;
        }
    }

    public async Task SaveAsync(MatchState state, string? initials)
    {
        try { await storage.SetItemAsStringAsync(KeyFor(initials), PoMuleSave.ToJson(state)); }
        catch { /* storage unavailable */ }
    }

    public async Task ClearAsync(string? initials)
    {
        try { await storage.RemoveItemAsync(KeyFor(initials)); }
        catch { /* storage unavailable */ }
    }
}

/// <summary>One line of the rivals and standings grids.</summary>
public sealed record PoMuleRow(int Rank, int Seat, string Name, string Color, string SpeciesName, int Cash, int[] Goods, int Plots, int NetWorth);

/// <summary>One point on the Net Worth chart.</summary>
public sealed record WorthPoint(int Month, int Worth);

public static class PoMuleUi
{
    /// <summary>
    /// Seat colours: the Atari game's red, blue, green and purple, then twelve more for the
    /// extra seats. The first eight are bright mid-tones and the second eight darker or
    /// duller ones, so seats 1 and 9 never look alike. All of them read on the pale map
    /// and on the dark panel.
    /// </summary>
    public static readonly string[] SeatColors =
    [
        "#e02828", "#2468f0", "#28a010", "#a828e0", "#e07000", "#0898a0", "#d83898", "#806020",
        "#8c1818", "#102c88", "#607800", "#503078", "#b88c00", "#0a6048", "#e06070", "#507090",
    ];

    public static readonly string[] GoodNames = ["Food", "Energy", "Smithore", "Crystite"];

    public static string PhaseName(Phase phase) => phase switch
    {
        Phase.Land => "Land grant",
        Phase.Auction => "Land auction",
        Phase.Development => "Development",
        Phase.Production => "Production",
        Phase.Event => "Colony event",
        Phase.Market => "Market",
        Phase.Standings => "Standings",
        _ => "Final results",
    };

    public static List<PoMuleRow> Rows(MatchState state) =>
        [.. PoMuleScoring.Standings(state).Select(s =>
        {
            var p = state.Players[s.Seat];
            return new PoMuleRow(s.Rank, s.Seat, p.Name, SeatColors[s.Seat], PoMuleSpecies.Name(p.Species, state.Classic),
                p.Cash, p.Goods, state.Owner.Count(o => o == s.Seat), s.NetWorth);
        })];
}
