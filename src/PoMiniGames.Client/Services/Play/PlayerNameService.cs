using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

public class PlayerNameService
{
    private const string StorageKey = "pominigames:player";
    private static readonly string[] Adjectives = ["Swift", "Bold", "Brave", "Cool", "Fast", "Wild", "Sharp", "Calm", "Sly", "Keen"];
    private static readonly string[] Nouns = ["Fox", "Bear", "Wolf", "Hawk", "Panda", "Tiger", "Lynx", "Raven", "Otter", "Gecko"];

    private string _playerName = string.Empty;
    private IJSRuntime? _jsRuntime;
    private TaskCompletionSource _initializedTcs = new(TaskCreationOptions.RunContinuationsAsynchronously);

    /// <summary>True once <see cref="InitializeAsync"/> has finished its first pass.</summary>
    public bool IsInitialized => _initializedTcs.Task.IsCompleted;

    /// <summary>Resolves when the first read-from-localStorage pass is complete.
    /// Used by AuthStateService so that a server-provided DisplayName is the
    /// final value (not the random adjective-noun fallback).</summary>
    public Task Initialized => _initializedTcs.Task;

    public string PlayerName
    {
        get => _playerName;
        private set
        {
            if (_playerName != value)
            {
                _playerName = value;
                StateChanged?.Invoke();
            }
        }
    }

    public event Action? StateChanged;

    public PlayerNameService(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
        _ = InitializeAsync();
    }

    public async Task InitializeAsync()
    {
        try
        {
            if (_jsRuntime is not null)
            {
                _playerName = await GetItemAsync(StorageKey) ?? "Player";
                if (string.IsNullOrEmpty(_playerName) || _playerName == "Player")
                {
                    var generated = GenerateRandomName();
                    _playerName = generated;
                    await SetItemAsync(StorageKey, generated);
                }
                StateChanged?.Invoke();
                _initializedTcs.TrySetResult();
                return;
            }
        }
        catch
        {
            // JS interop not available (e.g. pre-render)
        }
        _playerName = "Player";
        _initializedTcs.TrySetResult();
    }

    public void SetPlayerName(string name)
    {
        var trimmed = string.IsNullOrWhiteSpace(name) ? "Player" : name.Trim();
        PlayerName = trimmed;
        _ = PersistName(trimmed);
    }

    public void SetPlayerNameFromAuth(string name)
    {
        var trimmed = name.Trim();
        if (string.IsNullOrEmpty(trimmed)) return;
        PlayerName = trimmed;
        _ = PersistName(trimmed);
    }

    private static string GenerateRandomName()
    {
        var adj = Adjectives[Random.Shared.Next(Adjectives.Length)];
        var noun = Nouns[Random.Shared.Next(Nouns.Length)];
        var num = Random.Shared.Next(1, 100);
        return $"{adj}{noun}{num}";
    }

    public string GetPlayerName() => PlayerName;

    public string GetOrReadInitialName()
    {
        if (_playerName == "Player" || string.IsNullOrEmpty(_playerName))
        {
            var generated = GenerateRandomName();
            _playerName = generated;
            _ = PersistName(generated);
        }
        return _playerName;
    }

    private async Task PersistName(string name)
    {
        try
        {
            if (_jsRuntime is not null)
            {
                await SetItemAsync(StorageKey, name);
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
            var raw = await _jsRuntime.InvokeAsync<string>("window.localStorage.getItem", key);
            if (raw is null) return null;
            // If the stored value is a JSON-encoded string (e.g. "\"CalmTiger42\""), decode it
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
