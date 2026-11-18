namespace PoMiniGames.Features.Shared;

/// <summary>
/// Shared RFC 7807 validation and 400 ProblemDetails responses across API endpoints.
/// </summary>
internal static class ApiValidation
{
    public static IResult InvalidField(string field, string message) =>
        Results.ValidationProblem(new Dictionary<string, string[]> { [field] = [message] });

    public static IResult BadRequestProblem(string code, string detail) =>
        Results.Problem(title: code, detail: detail, statusCode: StatusCodes.Status400BadRequest);
}
