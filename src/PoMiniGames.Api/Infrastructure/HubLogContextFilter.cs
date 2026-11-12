using Microsoft.AspNetCore.SignalR;
using Serilog.Context;

namespace PoMiniGames.Infrastructure;

/// <summary>
/// SignalR analogue of <see cref="RequestLogContextMiddleware"/>. HTTP requests get
/// UserId/CorrelationId enrichment via that middleware, but SignalR hub invocations
/// bypass the HTTP pipeline entirely, so their logs would otherwise carry none of that
/// metadata. This <see cref="IHubFilter"/> pushes the connection's UserIdentifier and
/// ConnectionId into Serilog's ambient <c>LogContext</c> for the duration of every hub
/// method invocation, keeping dashboards consistent with the HTTP-side property names
/// (<c>UserId</c>).
/// </summary>
internal sealed class HubLogContextFilter : IHubFilter
{
    public async ValueTask<object?> InvokeMethodAsync(
        HubInvocationContext invocationContext,
        Func<HubInvocationContext, ValueTask<object?>> next)
    {
        var context = invocationContext.Context;
        var userId = context.UserIdentifier ?? "anonymous";

        using (LogContext.PushProperty("UserId", userId))
        using (LogContext.PushProperty("ConnectionId", context.ConnectionId))
        {
            return await next(invocationContext);
        }
    }
}
