using Microsoft.AspNetCore.Components;
using Microsoft.AspNetCore.Components.Routing;

using PoMiniGamesClient.Models;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Play;

/// <summary>
/// Centralized manager for the "Watch All Demos" auto-rotation kiosk mode.
///
/// Fixes a critical bug where each demo page created its own private
/// <c>System.Threading.Timer</c> for the per-demo 60s advance-to-next-demo logic.
/// Those timers survived Blazor's enhanced navigation and continued to fire
/// after the user manually navigated to another page, hijacking the user
/// back into the kiosk cycle. They also raced with each demo's own
/// "restart on game-over" loop, causing infinite re-loops on some pages
/// (notably PoFight).
///
/// Design contract:
///   • Only ONE kiosk timer exists for the lifetime of the Blazor session.
///   • Demo pages <c>Register</c> themselves (catalog) and call
///     <c>SetCurrent(key)</c> to report which demo is on screen. The
///     coordinator owns the timer, so canceling or stopping is centralized.
///   • On any <see cref="NavigationManager.LocationChanged"/>:
///       – Kiosk-internal navigations carry <c>?kiosk=N</c> in the URL.
///         The coordinator re-targets the timer to the new index and keeps
///         ticking, so the auto-rotation actually rotates.
///       – Any other navigation (Home, single-player, etc.) cancels the
///         active timer to prevent a stale timer from yanking the user
///         back into the kiosk cycle.
///   • Users can Pause/Resume/Skip/Exit via the on-screen kiosk control
///     bar (<c>Features/Shared/Shell/KioskControlBar.razor</c>, mounted once in
///     MainLayout). It renders only while <see cref="IsActive"/>.
/// </summary>
public sealed class KioskCoordinator : IDisposable
{
    private readonly NavigationManager _navigation;
    private readonly List<DemoEntry> _entries = new();
    private System.Threading.Timer? _timer;
    private string? _currentKey;
    private int _currentIndex;
    private bool _isPaused;
    private DateTimeOffset _advanceAtUtc;
    private int _remainingOnPause = AdvanceSeconds;
    private int _advanceIndex; // index of the demo to jump to on the next advance
    private bool _disposed;

    public event Action? Changed;

    public KioskCoordinator(NavigationManager navigation)
    {
        _navigation = navigation;
        _navigation.LocationChanged += OnLocationChanged;
    }

    public bool IsActive => _timer is not null;
    public bool IsPaused => _isPaused;
    public string? CurrentGameName { get; private set; }
    public int SecondsUntilAdvance { get; private set; } = AdvanceSeconds;
    /// <summary>How long every demo stays on screen, even if its match ends early.</summary>
    public const int AdvanceSeconds = 60;

    /// <summary>0-based index of the demo currently on screen. -1 before the first page reports itself.</summary>
    public int CurrentIndex => _currentIndex;
    /// <summary>Total demos in the reel.</summary>
    public int TotalCount => _entries.Count;

    public IReadOnlyList<DemoEntry> Entries => _entries;

    public void RegisterEntries(IEnumerable<DemoEntry> entries)
    {
        _entries.Clear();
        _entries.AddRange(entries);
        Changed?.Invoke();
    }

    /// <summary>
    /// Every demo in the catalog, in reel order. Shared by the home page's
    /// "Watch all demos" button and by <see cref="TryStartFromUrl"/>, so a reloaded
    /// or shared demo link rebuilds the exact same reel instead of a partial one.
    /// </summary>
    public static IReadOnlyList<DemoEntry> CatalogEntries() =>
        GameCatalog.Demo
            .Select(d => new DemoEntry(DemoKey(d), d.Url, d.Title, d.Icon))
            .ToList();

    /// <summary>Brawl's two demo entries carry the same GameKey; the reel keeps them apart.</summary>
    private static string DemoKey(CatalogEntry entry) =>
        entry.Url.Split('?', '#')[0] == "/pobrawl/ffa" ? "pobrawl-ffa" : entry.Key.Value;

    /// <summary>
    /// Register the catalog, arm the timer at <paramref name="index"/> and return the
    /// demo's URL with its <c>?kiosk=N</c> marker already applied. Null when the
    /// catalog has no demos, so callers can simply skip the navigation.
    /// </summary>
    public string? BeginFromCatalog(int index)
    {
        var entries = CatalogEntries();
        if (entries.Count == 0) return null;
        if (index < 0 || index >= entries.Count) index = 0;
        RegisterEntries(entries);
        Start(index);
        return WithKioskIndex(entries[index].Path, index);
    }

    /// <summary>
    /// Re-arm the reel from a URL that already carries <c>?kiosk=N</c>. Called once
    /// when the shell mounts: a hard reload (or a shared link) mid-reel used to land
    /// on the demo page with no controls and no rotation, because the coordinator
    /// only ever armed itself from a <see cref="NavigationManager.LocationChanged"/>,
    /// which a fresh document load never raises.
    /// </summary>
    public bool TryStartFromUrl(string? url)
    {
        if (_disposed || _timer is not null) return false;
        if (url is null || !TryGetKioskIndex(url, out var index)) return false;
        if (_entries.Count == 0) RegisterEntries(CatalogEntries());
        if (_entries.Count == 0) return false;

        var clamped = Math.Clamp(index, 0, _entries.Count - 1);
        Start(clamped);
        // Start() resets the "on screen" state; the page we are already showing is
        // the one at `clamped`, so report it before the first tick.
        _currentIndex = clamped;
        _currentKey = _entries[clamped].Key;
        CurrentGameName = _entries[clamped].DisplayName;
        Changed?.Invoke();
        return true;
    }

    private static string WithKioskIndex(string path, int index) =>
        $"{path}{(path.Contains('?') ? '&' : '?')}kiosk={index}";

    public void SetCurrent(string key)
    {
        _currentKey = key;
        CurrentGameName = _entries.FirstOrDefault(e => e.Key == key)?.DisplayName;
        _currentIndex = _entries.FindIndex(e => e.Key == key);
        var normalizedKey = key.EndsWith("-demo", StringComparison.OrdinalIgnoreCase)
            ? key[..^5]
            : key;
        _currentKey = normalizedKey;
        var entry = _entries.FirstOrDefault(e => string.Equals(e.Key, normalizedKey, StringComparison.OrdinalIgnoreCase)
                                              || string.Equals(e.Key, key, StringComparison.OrdinalIgnoreCase));
        if (entry is not null)
        {
            CurrentGameName = entry.DisplayName;
            _currentIndex = _entries.IndexOf(entry);
        }
        else
        {
            _currentIndex = _entries.FindIndex(e => string.Equals(e.Key, normalizedKey, StringComparison.OrdinalIgnoreCase));
            CurrentGameName = _currentIndex >= 0 ? _entries[_currentIndex].DisplayName : null;
        }
        SecondsUntilAdvance = AdvanceSeconds;
        _advanceAtUtc = DateTimeOffset.UtcNow.AddSeconds(AdvanceSeconds);
        _remainingOnPause = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Start(int advanceIndex)
    {
        Stop();
        _advanceIndex = advanceIndex;
        _advanceAtUtc = DateTimeOffset.UtcNow.AddSeconds(AdvanceSeconds);
        _remainingOnPause = AdvanceSeconds;
        _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
        Changed?.Invoke();
    }

    public void Stop()
    {
        _timer?.Dispose();
        _timer = null;
        _isPaused = false;
        _currentIndex = -1;
        _currentKey = null;
        CurrentGameName = null;
        SecondsUntilAdvance = AdvanceSeconds;
        _remainingOnPause = AdvanceSeconds;
        Changed?.Invoke();
    }

    public void Pause()
    {
        if (_isPaused) return;
        _remainingOnPause = Math.Max(1, (int)Math.Ceiling((_advanceAtUtc - DateTimeOffset.UtcNow).TotalSeconds));
        SecondsUntilAdvance = _remainingOnPause;
        _isPaused = true;
        Changed?.Invoke();
    }

    public void Resume()
    {
        if (!_isPaused) return;
        _isPaused = false;
        _advanceAtUtc = DateTimeOffset.UtcNow.AddSeconds(_remainingOnPause);
        Changed?.Invoke();
    }

    public void TogglePause()
    {
        if (_isPaused) Resume();
        else Pause();
    }

    public void SkipNext()
    {
        _timer?.Dispose();
        _timer = null;
        var next = (_advanceIndex + 1) % _entries.Count;
        _navigation.NavigateTo(WithKioskIndex(_entries[next].Path, next), forceLoad: false);
        Changed?.Invoke();
    }

    /// <summary>
    /// Jump to the previous demo in the reel. Symmetric with <see cref="SkipNext"/> —
    /// decrements with wrap-around so a museum visitor who missed a demo doesn't
    /// have to wait the full ~3-minute loop to see it again.
    /// </summary>
    public void PreviousDemo()
    {
        if (_entries.Count == 0) return;
        _timer?.Dispose();
        _timer = null;
        var prev = (_advanceIndex - 1 + _entries.Count) % _entries.Count;
        _navigation.NavigateTo(WithKioskIndex(_entries[prev].Path, prev), forceLoad: false);
        Changed?.Invoke();
    }

    /// <summary>
    /// <summary>
    /// Jump directly to a specific demo by its catalog index. Used by the home page's
    /// "start here" affordance so a passer-by can land on the most visually striking
    /// demo (PoVoxelStrike) instead of always opening on TicTacToe.
    /// </summary>
    public void JumpTo(int index)
    {
        if (_entries.Count == 0) return;
        if (index < 0 || index >= _entries.Count) return;
        // Resume the reel if it was already active; if not, take it from index 0 and
        // rotate forward from the chosen entry.
        if (_timer is null) Start(index);
        else
        {
            _timer.Dispose();
            _timer = null;
            _advanceIndex = index;
            _navigation.NavigateTo(WithKioskIndex(_entries[index].Path, index), forceLoad: false);
            Changed?.Invoke();
        }
    }

    public void Exit()
    {
        Stop();
        _navigation.NavigateTo("/", forceLoad: false);
    }

    private void OnTick()
    {
        if (_disposed || _timer is null) return;
        if (_isPaused) return;
        // Compute remaining time from wall-clock UTC so a slow/low-FPS 3D demo starving the
        // single-threaded WASM timer cannot stretch a 60s demo into several minutes.
        SecondsUntilAdvance = Math.Max(0, (int)Math.Ceiling((_advanceAtUtc - DateTimeOffset.UtcNow).TotalSeconds));
        Changed?.Invoke();
        if (SecondsUntilAdvance <= 0)
        {
            // Advance to next kiosk index. The SinglePlayerPage will pick
            // up the new index and route to the corresponding demo game.
            _timer?.Dispose();
            _timer = null;
            var next = (_advanceIndex + 1) % _entries.Count;
            _navigation.NavigateTo(WithKioskIndex(_entries[next].Path, next), forceLoad: false);
        }
    }

    private void OnLocationChanged(object? sender, LocationChangedEventArgs e)
    {
        // Kiosk-internal navigations carry ?kiosk=N in the query string —
        // these are emitted by the coordinator itself (Start, OnTick,
        // SkipNext) and must NOT cancel the timer, otherwise the very first
        // call to Start() followed by NavigateTo(...) would dispose the
        // timer before the first tick. Re-target the countdown to the new
        // index and (re)arm the timer if the previous non-kiosk navigation
        // had killed it.
        if (TryGetKioskIndex(e.Location, out var kioskIndex))
        {
            _advanceIndex = kioskIndex;
            _currentIndex = kioskIndex;
            if (kioskIndex >= 0 && kioskIndex < _entries.Count)
            {
                _currentKey = _entries[kioskIndex].Key;
                CurrentGameName = _entries[kioskIndex].DisplayName;
            }
            SecondsUntilAdvance = AdvanceSeconds;
            if (_timer is null && !_disposed)
            {
                _timer = new System.Threading.Timer(_ => OnTick(), null, 1000, 1000);
            }
            Changed?.Invoke();
            return;
        }

        // Any non-kiosk location change cancels the auto-tick. This is what
        // stops the "stale timer hijacks manual navigation" bug — if the
        // user clicks Home or a single-player game, the kiosk cycle stops
        // instead of yanking them back when the 60s demo dwell expires.
        if (_timer is not null)
        {
            _timer.Dispose();
            _timer = null;
            Changed?.Invoke();
        }
    }

    // Parses ?kiosk=N (or &kiosk=N) from a URL. Returns true and the index
    // when present and a non-negative integer; false otherwise.
    private static bool TryGetKioskIndex(string url, out int index)
    {
        index = 0;
        var qIdx = url.IndexOf('?');
        if (qIdx < 0) return false;
        foreach (var part in url[(qIdx + 1)..].Split('&'))
        {
            var eq = part.IndexOf('=');
            if (eq <= 0) continue;
            if (!string.Equals(part[..eq], "kiosk", StringComparison.OrdinalIgnoreCase)) continue;
            return int.TryParse(part[(eq + 1)..], out index) && index >= 0;
        }
        return false;
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _navigation.LocationChanged -= OnLocationChanged;
        _timer?.Dispose();
        _timer = null;
    }
}

public sealed record DemoEntry(string Key, string Path, string DisplayName, string Icon);
