namespace PoMiniGames.Infrastructure;

/// <summary>
/// Stamps the current request's correlation and session identifiers onto every outbound
/// HTTP call made through a typed <see cref="HttpClient"/>. Without this, a failure logged
/// by an upstream service cannot be tied back to the originating
/// in-app request, so production debugging is disjointed.
/// </summary>
internal sealed class CorrelationPropagationHandler : DelegatingHandler
{
    public const string CorrelationHeader = "X-Correlation-Id";
    public const string SessionHeader = "X-Session-Id";

    private readonly IHttpContextAccessor _httpContextAccessor;

    public CorrelationPropagationHandler(IHttpContextAccessor httpContextAccessor)
    {
        _httpContextAccessor = httpContextAccessor;
    }

    protected override Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var context = _httpContextAccessor.HttpContext;
        if (context is not null)
        {
            if (!request.Headers.Contains(CorrelationHeader)
                && !string.IsNullOrEmpty(context.TraceIdentifier))
            {
                request.Headers.TryAddWithoutValidation(CorrelationHeader, context.TraceIdentifier);
            }

            if (!request.Headers.Contains(SessionHeader)
                && context.Items.TryGetValue(RequestLogContextMiddleware.SessionItemKey, out var sessionId)
                && sessionId is string s && !string.IsNullOrEmpty(s))
            {
                request.Headers.TryAddWithoutValidation(SessionHeader, s);
            }
        }

        return base.SendAsync(request, cancellationToken);
    }
}
