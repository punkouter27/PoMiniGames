using System.Net;
using Microsoft.Playwright;

namespace PoMiniGames.E2EUI;

/// <summary>
/// Attaches Playwright console error, uncaught pageerror, requestfailed, unhandled >= 400
/// response, and Blazor unhandled error UI watchers to a page and fails on Dispose if triggered.
/// </summary>
internal sealed class PlaywrightErrorGuard : IAsyncDisposable
{
    private readonly IPage _page;
    private readonly List<(int Status, string UrlContains)> _allowedStatuses = [];
    private readonly List<string> _failures = [];

    private PlaywrightErrorGuard(IPage page)
    {
        _page = page;
        _page.Console += OnConsole;
        _page.PageError += OnPageError;
        _page.Crash += OnCrash;
        _page.RequestFailed += OnRequestFailed;
        _page.Response += OnResponse;
    }

    public static PlaywrightErrorGuard Watch(IPage page) => new(page);

    public void AllowHttp(HttpStatusCode status, string urlContains)
        => _allowedStatuses.Add(((int)status, urlContains));

    private void OnConsole(object? sender, IConsoleMessage msg)
    {
        if (msg.Type == "error")
        {
            _failures.Add($"browser console.error: {msg.Text}");
        }
    }

    private void OnPageError(object? sender, string err) =>
        _failures.Add($"browser pageerror: {err}");

    private void OnCrash(object? sender, IPage page) =>
        _failures.Add("browser page crashed");

    private void OnRequestFailed(object? sender, IRequest request)
    {
        if (string.Equals(request.Failure, "net::ERR_ABORTED", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        _failures.Add($"request failed: {request.Method} {request.Url} ({request.Failure})");
    }

    private void OnResponse(object? sender, IResponse response)
    {
        if (response.Status < 400 || IsAllowedStatus(response.Status, response.Url))
        {
            return;
        }
        _failures.Add($"HTTP {response.Status}: {response.Request.Method} {response.Url}");
    }

    private bool IsAllowedStatus(int status, string url)
        => _allowedStatuses.Any(rule =>
            rule.Status == status && url.Contains(rule.UrlContains, StringComparison.OrdinalIgnoreCase));

    public async ValueTask DisposeAsync()
    {
        _page.Console -= OnConsole;
        _page.PageError -= OnPageError;
        _page.Crash -= OnCrash;
        _page.RequestFailed -= OnRequestFailed;
        _page.Response -= OnResponse;

        try
        {
            var errorUiVisible = await _page.EvaluateAsync<bool>(
                "() => { const el = document.getElementById('blazor-error-ui'); return !!el && getComputedStyle(el).display !== 'none'; }");
            if (errorUiVisible)
            {
                _failures.Add("#blazor-error-ui became visible");
            }
        }
        catch
        {
            // Page/context already navigated or closed.
        }

        _failures.Should().BeEmpty("browser UI flows must complete with no console errors, failed assets, or unhandled HTTP 4xx/5xx responses");
    }
}
