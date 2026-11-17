using System.Text.Json;
using System.Text.Json.Serialization.Metadata;
using Microsoft.JSInterop;

namespace PoMiniGamesClient.Services.Play;

/// <summary>Trim-safe async localStorage service for DI consumers.</summary>
public interface IBrowserStorage
{
    ValueTask<string?> GetItemAsStringAsync(string key, CancellationToken ct = default);
    ValueTask SetItemAsStringAsync(string key, string value, CancellationToken ct = default);
    ValueTask RemoveItemAsync(string key, CancellationToken ct = default);
}

/// <summary>Default <see cref="IBrowserStorage"/> backed by <see cref="IJSRuntime"/>.</summary>
public sealed class BrowserStorageService(IJSRuntime js) : IBrowserStorage
{
    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values cross the JS boundary.")]
    public ValueTask<string?> GetItemAsStringAsync(string key, CancellationToken ct = default) =>
        js.InvokeAsync<string?>("window.localStorage.getItem", ct, key);

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values cross the JS boundary.")]
    public ValueTask SetItemAsStringAsync(string key, string value, CancellationToken ct = default) =>
        js.InvokeVoidAsync("window.localStorage.setItem", ct, key, value);

    public ValueTask RemoveItemAsync(string key, CancellationToken ct = default) =>
        js.InvokeVoidAsync("window.localStorage.removeItem", ct, key);
}

/// <summary>Synchronous localStorage helper used by WASM services initialized on startup.</summary>
public static class LocalStorageService
{
    private static IJSRuntime? _jsRuntime;

    public static void SetJSRuntime(IJSRuntime jsRuntime)
    {
        _jsRuntime = jsRuntime;
    }

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values are read from localStorage; no reflection-based JSON marshalling.")]
    private static string? RawGet(string key)
    {
        if (_jsRuntime is IJSInProcessRuntime inProcess)
            return inProcess.Invoke<string?>("window.localStorage.getItem", key);

        return _jsRuntime?.InvokeAsync<string?>("window.localStorage.getItem", key).AsTask().GetAwaiter().GetResult();
    }

    [System.Diagnostics.CodeAnalysis.UnconditionalSuppressMessage(
        "Trimming", "IL2026",
        Justification = "Only string values are written to localStorage; no reflection-based JSON marshalling.")]
    private static void RawSet(string key, string value)
    {
        if (_jsRuntime is IJSInProcessRuntime inProcess)
        {
            inProcess.InvokeVoid("window.localStorage.setItem", key, value);
            return;
        }

        _ = _jsRuntime?.InvokeVoidAsync("window.localStorage.setItem", key, value).AsTask();
    }

    public static T? GetItem<T>(string key, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return default;
        try
        {
            if (typeof(T) == typeof(string))
            {
                var raw = RawGet(key);
                if (raw is null) return default;
                if (raw.Length >= 2 && raw[0] == '"' && raw[^1] == '"')
                {
                    try { return (T)(object)JsonDocument.Parse(raw).RootElement.GetString()!; }
                    catch { /* fall through to raw */ }
                }
                return (T)(object)raw;
            }
            if (typeInfo is null) return default;
            var rawJson = RawGet(key);
            if (rawJson is null) return default;
            return JsonSerializer.Deserialize(rawJson, typeInfo);
        }
        catch
        {
            return default;
        }
    }

    public static void SetItem<T>(string key, T value, JsonTypeInfo<T>? typeInfo = null)
    {
        if (_jsRuntime == null) return;
        try
        {
            if (value is string s)
            {
                RawSet(key, s);
            }
            else if (typeInfo is not null)
            {
                var json = JsonSerializer.Serialize(value, typeInfo);
                RawSet(key, json);
            }
        }
        catch { }
    }
}
