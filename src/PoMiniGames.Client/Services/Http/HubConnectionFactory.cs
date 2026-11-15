using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Http.Connections;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.AspNetCore.SignalR.Protocol;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// The single construction path for every SignalR hub connection in the client.
/// Bakes in the three things every hub connection here must have:
/// <list type="bullet">
/// <item>The player id and initials on the query string (a WebSocket cannot carry
/// custom headers); the hubs read them through <c>UsePlayerIdentity</c>.</item>
/// <item>SignalR's default HttpClientFactory doesn't flow through DI, so every
/// connection forces the credentials handler
/// (<see cref="SignalRCredentialsHttpClientFactory.CreateHandler"/>) — see that class.</item>
/// <item>Automatic reconnect, so a dropped WebSocket heals instead of leaving
/// the lobby/race dead.</item>
/// </list>
/// </summary>
public static class HubConnectionFactory
{
    /// <summary>
    /// Build a hub connection with the credentials handler and automatic
    /// reconnect applied.
    /// </summary>
    /// <param name="hubUrl">Absolute hub URL — compose via <see cref="ApiEndpoints.Hub"/>;
    /// SignalR does not honour the DI HttpClient BaseAddress (see <see cref="ApiEndpoints"/>).</param>
    /// <param name="transports">Optional transport restriction (e.g. FunQuiz's
    /// dev-box escape hatch that skips the slow WebSocket upgrade). Null keeps
    /// SignalR's default transport negotiation.</param>
    /// <param name="reconnectDelays">Optional custom reconnect backoff; null uses
    /// SignalR's default 0/2/10/30s schedule.</param>
    /// <summary>
    /// The player identity every hub connection carries, as query parameters: a WebSocket
    /// cannot send the <c>X-Player-Id</c> / <c>X-Player-Initials</c> headers REST calls use.
    /// </summary>
    public static string? PlayerId { get; set; }
    public static string? PlayerInitials { get; set; }

    /// <param name="protocolDecorator">Optional game-specific inbound fast path around the configured JSON protocol.</param>
    public static HubConnection Create(string hubUrl, HttpTransportType? transports = null, TimeSpan[]? reconnectDelays = null,
        Func<IHubProtocol, IHubProtocol>? protocolDecorator = null)
    {
        var sep = hubUrl.Contains('?') ? '&' : '?';
        var resolvedUrl = hubUrl;
        if (!string.IsNullOrEmpty(PlayerId))
        {
            resolvedUrl += $"{sep}playerId={Uri.EscapeDataString(PlayerId)}&initials={Uri.EscapeDataString(PlayerInitials ?? "   ")}";
        }

        var builder = new HubConnectionBuilder()
            .WithUrl(resolvedUrl, options =>
            {
                options.HttpMessageHandlerFactory = SignalRCredentialsHttpClientFactory.CreateHandler;
                if (transports is { } restricted) options.Transports = restricted;
            })
            // PoBrawlOnline: the server-side hub protocol serialises
            // enums as camelCase strings via JsonStringEnumConverter (Program.cs
            // AddJsonProtocol). The SignalR client's default JSON uses numbers for
            // enums, so deserialising PoBrawlSide etc. fails with
            // "DeserializeUnableToConvertValue". Apply the same converter so the
            // client and server agree on the wire format for every hub the app uses.
            .AddJsonProtocol(options =>
            {
                options.PayloadSerializerOptions.Converters.Add(
                    new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
                // Source-generated metadata for the Shared hub DTOs, reflection behind it.
                PoMiniGames.Shared.Games.HubJsonContext.Apply(options.PayloadSerializerOptions);
            });
        builder = reconnectDelays is null
            ? builder.WithAutomaticReconnect()
            : builder.WithAutomaticReconnect(reconnectDelays);
        if (protocolDecorator is not null)
        {
            builder.Services.AddSingleton<IHubProtocol>(services => protocolDecorator(
                new JsonHubProtocol(services.GetRequiredService<IOptions<Microsoft.AspNetCore.SignalR.JsonHubProtocolOptions>>())));
        }
        return builder.Build();
    }
}
