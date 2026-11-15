using System.Net.Http;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// SignalR credentials pass-through handler factory.
///
/// <see cref="Microsoft.AspNetCore.SignalR.Client.HubConnectionBuilder"/> with the
/// string-only <c>WithUrl(string)</c> overload constructs its own internal
/// <see cref="HttpClient"/> for the negotiate POST. That HttpClient is created via
/// <c>HttpConnectionOptions.DefaultHttpClientFactory</c>, which is a plain
/// <c>new HttpClient()</c> — it does NOT flow through the DI pipeline, so the
/// <see cref="IncludeCredentialsHandler"/> that every other request in the app goes
/// through never wraps it, and on a cross-origin dev setup the negotiate POST drops the
/// site's cookies.
///
/// Fix: assign <see cref="CreateHandler"/> to
/// <c>HttpConnectionOptions.HttpMessageHandlerFactory</c> on every
/// <c>HubConnectionBuilder.WithUrl(url, options =&gt; …)</c> call so the negotiate
/// request goes out through the same <see cref="IncludeCredentialsHandler"/> chain
/// the DI <see cref="HttpClient"/> uses. The player identity itself rides on the hub URL's
/// query string (<see cref="HubConnectionFactory"/>), not on a cookie.
/// <see cref="HubConnectionFactory.Create"/> is the one place that wiring
/// happens — every client hub connection is built through it.
///
/// The handler chain mirrors the DI HttpClient registered in <c>Program.cs</c>:
///   <c>IncludeCredentialsHandler → HttpClientHandler</c>.
/// <see cref="TransientRetryHandler"/> is intentionally omitted — SignalR negotiates
/// only on connect (single POST) and handles its own transport reconnects; wrapping
/// it adds nothing.
///
/// Used by <see cref="HubConnectionFactory"/>, the single construction path for
/// every SignalR hub connection in the client.
/// </summary>
public static class SignalRCredentialsHttpClientFactory
{
    /// <summary>
    /// <see cref="Microsoft.AspNetCore.Http.Connections.Client.HttpConnectionOptions.HttpMessageHandlerFactory"/>
    /// is typed as <c>Func&lt;HttpMessageHandler, HttpMessageHandler&gt;</c> — it
    /// supplies the default inner handler (a fresh <see cref="HttpClientHandler"/>
    /// backed by the WASM browser fetch shim) and we return a delegating chain
    /// that forces <c>credentials: 'include'</c>. SignalR owns the outer
    /// <see cref="HttpClient"/> and disposes the returned handler with the
    /// <see cref="Microsoft.AspNetCore.SignalR.Client.HubConnection"/>.
    /// </summary>
    public static HttpMessageHandler CreateHandler(HttpMessageHandler innerHandler) => new IncludeCredentialsHandler
    {
        InnerHandler = innerHandler
    };
}
