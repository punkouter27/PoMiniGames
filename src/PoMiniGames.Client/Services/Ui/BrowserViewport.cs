using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// Lightweight viewport-width helper used by Razor components that need to
/// render different amounts of data on phone vs desktop (e.g. leaderboards
/// show top-3 on mobile, top-10 on desktop).
///
/// Components inject this scoped service and call <see cref="RefreshAsync"/>
/// inside OnAfterRenderAsync, then read <see cref="IsNarrow"/> from their
/// build pass. It is read when asked, not on resize: call RefreshAsync again to
/// pick up a rotated phone.
/// </summary>
public sealed class BrowserViewport
{
    public const int NarrowBreakpointPx = 640;

    private readonly IJSRuntime _js;

    public BrowserViewport(IJSRuntime js) => _js = js;

    /// <summary>True when the viewport is &lt;= <see cref="NarrowBreakpointPx"/> wide.</summary>
    public bool IsNarrow { get; private set; }

    /// <summary>
    /// Reads window.innerWidth and updates <see cref="IsNarrow"/>. Safe to invoke from
    /// OnAfterRenderAsync — throws are swallowed and the previous value sticks.
    /// </summary>
    public async Task RefreshAsync()
    {
        try
        {
            // A named function (js/platform/app.js), not "eval": the CSP has no 'unsafe-eval',
            // so the eval call threw, was swallowed below, and IsNarrow stayed false on phones.
            var w = await _js.InvokeAsync<int>("PoViewport.width");
            IsNarrow = w > 0 && w <= NarrowBreakpointPx;
        }
        catch
        {
            // No-op: render with last known value.
        }
    }
}
