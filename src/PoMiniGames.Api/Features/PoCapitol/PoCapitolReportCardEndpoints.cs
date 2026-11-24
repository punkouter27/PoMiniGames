using FluentValidation;
using PoMiniGames.Shared.Games;
using PoMiniGames.Shared.Validation;

namespace PoMiniGames.Features.PoCapitol;

/// <summary>
/// PoCapitol's after-action report card: the client posts the attempt's summary and series and
/// gets back a 1200x630 PNG. Stateless: nothing is stored and no identity is read.
/// </summary>
internal static class PoCapitolReportCardEndpoints
{
    public static IEndpointRouteBuilder MapPoCapitolReportCardEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/pocapitol/report-card", (PoCapitolReportCardRequest? request, IValidator<PoCapitolReportCardRequest> validator) =>
            {
                if (request is null)
                    return Results.ValidationProblem(new Dictionary<string, string[]> { ["body"] = ["A report is required."] });
                var result = validator.Validate(request);
                if (!result.IsValid) return Results.ValidationProblem(result.ToDictionary());
                return Results.File(PoCapitolReportCardRenderer.Render(request), "image/png");
            })
            .WithTags("PoCapitol")
            .WithName("PostPoCapitolReportCard")
            .Produces(StatusCodes.Status200OK, contentType: "image/png")
            .ProducesValidationProblem()
            .RequireRateLimiting("leaderboard-read");
        return app;
    }
}
