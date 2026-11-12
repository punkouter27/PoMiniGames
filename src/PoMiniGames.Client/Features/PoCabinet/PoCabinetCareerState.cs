using System.Text.Json;
using Blazored.LocalStorage;
using PoMiniGames.Shared.Games;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// The player's campaign progress, stored in this browser's <c>localStorage</c> via
/// Blazored.LocalStorage's <c>*AsString</c> methods (the generic overloads go through
/// reflection-based JSON that the trim analyzer rejects).
/// </summary>
public sealed class PoCabinetCareerState
{
    private const string StorageKey = "pominigames:pocabinet-career-v1";

    private readonly ILocalStorageService _storage;

    public PoCabinetCareerState(ILocalStorageService storage) => _storage = storage;

    /// <summary>Current state (loaded from storage, or fresh state if none).</summary>
    public PoCabinetCareerDto Current { get; set; } = PoCabinetCareerDto.New();

    /// <summary>Raised when <see cref="RecordStageResultAsync"/> or <see cref="ResetAsync"/>
    /// changes state; the track selector's campaign bar redraws.</summary>
    public event Action? Changed;

    /// <summary>True if storage I/O is available — false means no persistence this session.</summary>
    private bool StorageAvailable { get; set; }

    public async Task LoadAsync()
    {
        try
        {
            var raw = await _storage.GetItemAsStringAsync(StorageKey);
            StorageAvailable = true;
            if (string.IsNullOrWhiteSpace(raw)) return;
            // Source-generated serializer (PoCabinetJsonContext) is trim-safe and the
            // framework requires it (IL2026 otherwise).
            var parsed = JsonSerializer.Deserialize(raw, PoCabinetJsonContext.Default.PoCabinetCareerDto);
            if (parsed is not null)
            {
                // A hand-edited or half-written entry: a null list or an out-of-range stage
                // would crash the track list, so it is put right rather than trusted.
                parsed.CompletedStages ??= [];
                parsed.CurrentStageIndex = Math.Clamp(parsed.CurrentStageIndex, 0, PoCabinetCatalog.CampaignStages - 1);
                Current = parsed;
            }
        }
        catch (JsonException)
        {
            // A corrupt entry: start the campaign over, and let the next result overwrite it.
            // (It used to count as "storage unavailable", so nothing was ever saved again.)
            Current = PoCabinetCareerDto.New();
        }
        catch
        {
            // Storage unavailable (private mode, quota, etc.) — fall back to in-memory.
            StorageAvailable = false;
        }
    }

    public async Task SaveAsync()
    {
        if (!StorageAvailable) return;
        try
        {
            var json = JsonSerializer.Serialize(Current, PoCabinetJsonContext.Default.PoCabinetCareerDto);
            await _storage.SetItemAsStringAsync(StorageKey, json);
        }
        catch
        {
            // ignore — already-in-memory is the fallback
        }
    }

    /// <summary>Advance to the next stage on a top-quarter finish in the 64-car field
    /// (<see cref="PoCabinetCatalog.CampaignPassPlace"/>); a top-six finish in the final race wins the trophy.</summary>
    public async Task RecordStageResultAsync(int stageIndex, int finishPosition)
    {
        if (finishPosition <= PoCabinetCatalog.CampaignPassPlace && stageIndex == Current.CurrentStageIndex)
        {
            if (!Current.CompletedStages.Contains(stageIndex))
                Current.CompletedStages = Current.CompletedStages.Append(stageIndex).ToList();
            var final = PoCabinetCatalog.CampaignStages - 1;
            Current.CurrentStageIndex = Math.Min(stageIndex + 1, final);
            if (stageIndex == final && finishPosition <= PoCabinetCatalog.CampaignTrophyPlace) Current.TrophyUnlocked = true;
            await SaveAsync();
            Changed?.Invoke();
        }
    }
}
