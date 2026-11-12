namespace PoMiniGamesClient.Layout;

/// <summary>Static dev/test persona descriptors for the header AccountMenu switcher.</summary>
public static class AccountMenu
{
    public sealed record PersonaOption(string Label, string? FakeUserHeader);

    public static readonly IReadOnlyList<PersonaOption> Personas =
    [
        new("Session User", null),
        new("Alice (Dev)", "alice@example.com"),
        new("Bob (Dev)", "bob@example.com"),
    ];
}
