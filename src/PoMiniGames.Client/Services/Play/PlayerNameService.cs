using Microsoft.JSInterop;
using PoMiniGamesClient.Services.Http;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Manages the player's 1980s arcade 3-letter initials (or 3 blank spaces if skipped)
/// and a persistent per-browser device ID in <c>localStorage</c> so scores and
/// multiplayer sessions never collide even when two players skip or share initials.
/// </summary>
public class PlayerNameService
{
    private const string InitialsStorageKey = "pominigames:initials";
    private const string PlayerIdStorageKey = "pominigames:playerid";
    public const string BlankInitials = "   ";

    private string _initials = BlankInitials;
    private string _playerId = string.Empty;
    private bool _hasPrompted;
    private bool _isPromptOpen;
    private readonly IJSRuntime? _jsRuntime;
    private readonly TaskCompletionSource _initializedTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public bool IsInitialized => _initializedTcs.Task.IsCompleted;
    public Task Initialized => _initializedTcs.Task;

    /// <summary>True once the user has either entered 3-letter initials or clicked Skip.</summary>
    public bool HasPrompted => _hasPrompted;

    /// <summary>True when the arcade initials modal should be shown.</summary>
    public bool IsPromptOpen => _isPromptOpen;

    /// <summary>Exact 3-character arcade initials ("ABC" or "   " if skipped).</summary>
    public string Initials => _initials;

    /// <summary>Stable per-browser ID stored in localStorage to prevent collisions.</summary>
    public string PlayerId => _playerId;

    /// <summary>Backwards-compatible alias for <see cref="Initials"/>.</summary>
    public string PlayerName => _initials;

    public event Action? StateChanged;

    public PlayerNameService(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
        _ = InitializeAsync();
    }

    public async Task InitializeAsync()
    {
        if (_initializedTcs.Task.IsCompleted)
        {
            return;
        }

        try
        {
            if (_jsRuntime is not null)
            {
                var storedId = await GetItemAsync(PlayerIdStorageKey);
                if (string.IsNullOrWhiteSpace(storedId))
                {
                    storedId = Guid.NewGuid().ToString("N")[..16];
                    await SetItemAsync(PlayerIdStorageKey, storedId);
                }
                _playerId = storedId.Trim();

                var storedInitials = await GetItemAsync(InitialsStorageKey);
                if (storedInitials is not null)
                {
                    _initials = NormalizeInitials(storedInitials);
                    _hasPrompted = true;
                    _isPromptOpen = false;
                }
                else
                {
                    _initials = BlankInitials;
                    _hasPrompted = false;
                    _isPromptOpen = true;
                }

                SyncHubIdentity();
                // Ready first, then announce: the prompt re-checks IsInitialized when this event
                // fires, and announcing before the task completed left a first-time visitor with
                // no prompt at all (it saw "not initialized" and nothing ever asked again).
                _initializedTcs.TrySetResult();
                StateChanged?.Invoke();
                return;
            }
        }
        catch
        {
            // JS interop not available (e.g. pre-render)
        }

        if (string.IsNullOrEmpty(_playerId))
        {
            _playerId = Guid.NewGuid().ToString("N")[..16];
        }
        _initials = BlankInitials;
        SyncHubIdentity();
        _initializedTcs.TrySetResult();
        StateChanged?.Invoke();
    }

    public void RequestOpenPrompt()
    {
        _isPromptOpen = true;
        StateChanged?.Invoke();
    }

    public void ClosePrompt()
    {
        if (!_hasPrompted)
        {
            SkipInitials();
            return;
        }

        _isPromptOpen = false;
        StateChanged?.Invoke();
    }

    public void SetInitials(string? raw)
    {
        var normalized = NormalizeInitials(raw);
        _initials = normalized;
        _hasPrompted = true;
        _isPromptOpen = false;
        SyncHubIdentity();
        _ = PersistAsync(InitialsStorageKey, normalized);
        StateChanged?.Invoke();
    }

    public void SkipInitials()
    {
        _initials = BlankInitials;
        _hasPrompted = true;
        _isPromptOpen = false;
        SyncHubIdentity();
        _ = PersistAsync(InitialsStorageKey, BlankInitials);
        StateChanged?.Invoke();
    }

    public void SetPlayerName(string name) => SetInitials(name);

    public string GetPlayerName() => _initials;

    public string GetOrReadInitialName() => _initials;

    /// <summary>Normalizes input to 3 uppercase ASCII letters (A-Z), or 3 spaces if invalid/empty.</summary>
    public static string NormalizeInitials(string? raw)
    {
        if (string.IsNullOrEmpty(raw))
        {
            return BlankInitials;
        }

        Span<char> buffer = stackalloc char[3];
        var count = 0;
        foreach (var ch in raw)
        {
            if (ch is >= 'a' and <= 'z')
            {
                buffer[count++] = (char)(ch - 'a' + 'A');
            }
            else if (ch is >= 'A' and <= 'Z')
            {
                buffer[count++] = ch;
            }

            if (count == 3)
            {
                break;
            }
        }

        return count == 3 ? new string(buffer) : BlankInitials;
    }

    private void SyncHubIdentity()
    {
        HubConnectionFactory.PlayerId = _playerId;
        HubConnectionFactory.PlayerInitials = _initials;
    }

    private async Task PersistAsync(string key, string value)
    {
        try
        {
            if (_jsRuntime is not null)
            {
                await SetItemAsync(key, value);
            }
        }
        catch
        {
            // ignore
        }
    }

    private async Task<string?> GetItemAsync(string key)
    {
        if (_jsRuntime == null) return null;
        try
        {
            var raw = await _jsRuntime.InvokeAsync<string?>("window.localStorage.getItem", key);
            if (raw is null) return null;
            if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"')
            {
                try
                {
                    using var doc = System.Text.Json.JsonDocument.Parse(raw);
                    if (doc.RootElement.ValueKind == System.Text.Json.JsonValueKind.String)
                        return doc.RootElement.GetString();
                }
                catch { /* fall through to raw */ }
            }
            return raw;
        }
        catch
        {
            return null;
        }
    }

    private async Task SetItemAsync(string key, string value)
    {
        if (_jsRuntime == null) return;
        try
        {
            await _jsRuntime.InvokeVoidAsync("window.localStorage.setItem", key, value);
        }
        catch { }
    }
}
