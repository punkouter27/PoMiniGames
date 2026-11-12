namespace PoMiniGamesClient.Services.Http;

/// <summary>
/// Attaches <c>X-Fake-User</c> on outgoing requests when a Dev/Test persona is selected
/// from the account menu in non-Production environments.
/// </summary>
public sealed class DevFakeUserHandler : DelegatingHandler
{
    public static string? ActiveFakeUser { get; set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(ActiveFakeUser) && !request.Headers.Contains("X-Fake-User"))
        {
            request.Headers.TryAddWithoutValidation("X-Fake-User", ActiveFakeUser);
        }

        return base.SendAsync(request, cancellationToken);
    }
}
