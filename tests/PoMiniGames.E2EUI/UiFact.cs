using System.Diagnostics;

namespace PoMiniGames.E2EUI;

/// <summary>
/// What a browser test needs on this machine, checked once per run: a Docker engine (the fixture's Testcontainers
/// Azurite) and an installed Playwright Chromium (the csproj installs it before the first run). When either is
/// missing every UI test SKIPS with one clear reason instead of failing. The E2E tiers are local-only, never CI.
/// </summary>
internal static class UiEnvironment
{
    private static readonly Lazy<string?> Missing = new(Probe);

    /// <summary>Null when the tier can run, else why it is skipped.</summary>
    public static string? SkipReason => Missing.Value;

    private static string? Probe()
    {
        if (!DockerAnswers())
        {
            return "Docker is not running, so the E2E-UI tier (Testcontainers Azurite + Kestrel) is skipped. Start Docker Desktop and run it again.";
        }

        return ChromiumInstalled()
            ? null
            : "No Playwright Chromium is installed, so the E2E-UI tier is skipped. Run `pwsh tests/PoMiniGames.E2EUI/bin/Debug/net10.0/playwright.ps1 install chromium`.";
    }

    private static bool DockerAnswers()
    {
        try
        {
            using var docker = Process.Start(new ProcessStartInfo("docker", "version --format {{.Server.Version}}")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
            if (docker is null)
            {
                return false;
            }

            var output = docker.StandardOutput.ReadToEndAsync();
            if (!docker.WaitForExit(TimeSpan.FromSeconds(20)))
            {
                docker.Kill(entireProcessTree: true);
                return false;
            }

            return docker.ExitCode == 0 && !string.IsNullOrWhiteSpace(output.GetAwaiter().GetResult());
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return false; // no docker CLI on PATH
        }
    }

    // Playwright's browser cache: PLAYWRIGHT_BROWSERS_PATH, else the per-OS default.
    private static bool ChromiumInstalled()
    {
        var root = Environment.GetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH");
        if (string.IsNullOrWhiteSpace(root) || root == "0")
        {
            root = OperatingSystem.IsWindows()
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ms-playwright")
                : OperatingSystem.IsMacOS()
                    ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Library", "Caches", "ms-playwright")
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".cache", "ms-playwright");
        }

        return Directory.Exists(root) && Directory.EnumerateDirectories(root, "chromium*").Any();
    }
}

/// <summary>A <see cref="FactAttribute"/> that skips, with one clear reason, when Docker or Chromium is missing.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class UiFactAttribute : FactAttribute
{
    public UiFactAttribute()
    {
        if (UiEnvironment.SkipReason is { } reason)
        {
            Skip = reason;
        }
    }
}

/// <summary>A <see cref="TheoryAttribute"/> that skips, with one clear reason, when Docker or Chromium is missing.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class UiTheoryAttribute : TheoryAttribute
{
    public UiTheoryAttribute()
    {
        if (UiEnvironment.SkipReason is { } reason)
        {
            Skip = reason;
        }
    }
}
