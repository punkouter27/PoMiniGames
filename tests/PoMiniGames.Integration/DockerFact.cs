using System.Diagnostics;

namespace PoMiniGames.Integration;

/// <summary>
/// Whether a Docker engine answers on this machine, asked once per test run. The Integration tier runs against a
/// Testcontainers Azurite; without Docker every test SKIPS with <see cref="SkipReason"/> instead of failing (or,
/// worse, silently passing without storage). CI (ubuntu-latest) always has Docker.
/// </summary>
internal static class DockerProbe
{
    public const string SkipReason =
        "Docker is not running, so the Integration tier (Testcontainers Azurite) is skipped. Start Docker Desktop and run it again.";

    private static readonly Lazy<bool> Available = new(Probe);

    public static bool IsAvailable => Available.Value;

    private static bool Probe()
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
}

/// <summary>A <see cref="FactAttribute"/> that skips, with one clear reason, when Docker is not running.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class DockerFactAttribute : FactAttribute
{
    public DockerFactAttribute()
    {
        if (!DockerProbe.IsAvailable)
        {
            Skip = DockerProbe.SkipReason;
        }
    }
}

/// <summary>A <see cref="TheoryAttribute"/> that skips, with one clear reason, when Docker is not running.</summary>
[AttributeUsage(AttributeTargets.Method)]
public sealed class DockerTheoryAttribute : TheoryAttribute
{
    public DockerTheoryAttribute()
    {
        if (!DockerProbe.IsAvailable)
        {
            Skip = DockerProbe.SkipReason;
        }
    }
}
