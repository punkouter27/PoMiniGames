using Blazored.LocalStorage;
using PoMiniGames.Shared.Games.PoMule;

namespace PoMiniGamesClient.Features.PoMule;

/// <summary>
/// The one match in progress, kept in the browser between months so a reload or a closed tab
/// does not throw away twenty minutes of play.
/// </summary>
/// <remarks>
/// String API only: Blazored's generic overloads serialise by reflection, which the trim
/// analyzer rejects. Storage can be unavailable (private mode), so every call swallows its
/// failure: the match plays on, it just cannot be resumed.
/// </remarks>
public sealed class PoMuleSaveStore(ILocalStorageService storage)
{
    private const string Key = "pomule.save.v1";

    /// <summary>The saved match, or null when there is none or it is from older rules.</summary>
    public async Task<MatchState?> LoadAsync()
    {
        try
        {
            var state = PoMuleSave.FromJson(await storage.GetItemAsStringAsync(Key));
            // A finished match has nothing left to continue.
            return state is { Phase: not Phase.Finished } ? state : null;
        }
        catch
        {
            return null;
        }
    }

    public async Task SaveAsync(MatchState state)
    {
        try { await storage.SetItemAsStringAsync(Key, PoMuleSave.ToJson(state)); }
        catch { /* storage unavailable */ }
    }

    public async Task ClearAsync()
    {
        try { await storage.RemoveItemAsync(Key); }
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
    /// Seat colours: the Atari game's red, blue, green and purple, plus four more for the
    /// extra seats. Saturated mid-tones, so they read on the pale map and on the dark panel.
    /// </summary>
    public static readonly string[] SeatColors =
        ["#e02828", "#2468f0", "#28a010", "#a828e0", "#e07000", "#0898a0", "#d83898", "#806020"];

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
