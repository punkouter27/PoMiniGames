using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Whether the browser currently has a network connection, pushed from the JS
/// <c>online</c>/<c>offline</c> events rather than polled.
/// </summary>
/// <remarks>
/// Offline support is only useful if it is visible: with a service worker installed,
/// a disconnected player still gets a fully working app shell, so without a signal
/// the failure of an online-only game reads as a bug rather than as "you are offline".
///
/// This tracks <c>navigator.onLine</c>, which reports link state — not whether our
/// server is reachable. It can therefore say "online" on a captive portal. That is
/// acceptable for driving a banner and disabling online-only entries; it must not be
/// used to decide whether a write succeeded. Score submission already handles real
/// failures by parking in <see cref="ScoreSyncService"/> and replaying on reconnect.
/// </remarks>
public sealed class OnlineStatusService : IAsyncDisposable
{
    private readonly IJSRuntime _js;
    private DotNetObjectReference<OnlineStatusService>? _selfRef;
    private bool _initialized;

    public OnlineStatusService(IJSRuntime js) => _js = js;

    /// <summary>Optimistic until the first signal arrives: a brand-new session that
    /// cannot reach JS should not be announced to the user as offline.</summary>
    public bool IsOnline { get; private set; } = true;

    public event Action? StateChanged;

    /// <summary>Idempotent — MainLayout calls this once, but re-renders must not
    /// stack duplicate event listeners.</summary>
    public async Task InitializeAsync()
    {
        if (_initialized) return;
        _initialized = true;
        try
        {
            _selfRef = DotNetObjectReference.Create(this);
            IsOnline = await _js.InvokeAsync<bool>("poPwa.setOnlineListener", _selfRef);
            StateChanged?.Invoke();
        }
        catch
        {
            // Prerender, a test host without the script, or JS disabled. Stay
            // optimistic rather than showing a false offline banner.
            IsOnline = true;
        }
    }

    [JSInvokable]
    public void OnConnectivityChanged(bool isOnline)
    {
        if (IsOnline == isOnline) return;
        IsOnline = isOnline;
        StateChanged?.Invoke();
    }

    public ValueTask DisposeAsync()
    {
        _selfRef?.Dispose();
        _selfRef = null;
        return ValueTask.CompletedTask;
    }
}
