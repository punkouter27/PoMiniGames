using System.Diagnostics.CodeAnalysis;
using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Play;

namespace PoMiniGamesClient.Services.Auth;

/// <summary>
/// Lightweight compatibility facade over <see cref="PlayerNameService"/> after OAuth removal.
/// Every visitor is immediately active with their 3-letter arcade initials (or "   " if skipped)
/// and their persistent local device ID.
/// </summary>
[SuppressMessage("Performance", "CA1822:Mark members as static", Justification = "Compatibility surface injected as an instance service by Razor components.")]
public sealed class AuthStateService : IDisposable
{
    private readonly PlayerNameService _playerName;

    public AuthClientConfiguration? Config { get; } = new()
    {
        Enabled = true,
        MicrosoftEnabled = false,
        MicrosoftConfigured = false,
        DevLoginEnabled = false,
    };

    public AuthenticatedUserProfile? User => new()
    {
        UserId = _playerName.PlayerId,
        DisplayName = _playerName.Initials,
        Email = null,
    };

    public bool IsConfigured => true;
    public bool IsAuthenticated => true;
    public bool IsLoading => !_playerName.IsInitialized;
    public bool MicrosoftEnabled => false;
    public bool MicrosoftConfigured => false;
    public bool DevLoginEnabled => false;
    public string? Error => null;

    public event Action? StateChanged;

    public AuthStateService(PlayerNameService playerName)
    {
        _playerName = playerName;
        _playerName.StateChanged += OnPlayerStateChanged;
    }

    public Task InitializeAsync(string? queryString = null) => _playerName.InitializeAsync();

    public Task RefreshAsync() => _playerName.InitializeAsync();

    public void Dispose()
    {
        _playerName.StateChanged -= OnPlayerStateChanged;
    }

    private void OnPlayerStateChanged() => StateChanged?.Invoke();
}
