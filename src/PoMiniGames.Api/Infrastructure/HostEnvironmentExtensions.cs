namespace PoMiniGames.Infrastructure;

/// <summary>
/// The one definition of "a non-production environment" (Development or the E2E "Test"
/// environment). Dev-login, fake auth, mock AI and the lenient Key Vault load all gate on it,
/// and a drifted copy would strand sessions or leak a dev pathway into Production.
/// </summary>
internal static class HostEnvironmentExtensions
{
    public static bool IsDevOrTest(this IHostEnvironment environment)
        => environment.IsDevelopment() || environment.IsEnvironment("Test");
}
