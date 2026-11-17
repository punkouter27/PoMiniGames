using FluentValidation;

namespace PoMiniGames.Shared.Validation;

/// <summary>The first-visit / "Change initials" entry: exactly three letters A to Z.</summary>
public sealed class InitialsInput
{
    public string Initials { get; set; } = string.Empty;
}

/// <summary>Rules for <see cref="InitialsInput"/>. The server's identity middleware applies the same rule.</summary>
public sealed class InitialsInputValidator : AbstractValidator<InitialsInput>
{
    public InitialsInputValidator()
    {
        RuleFor(x => x.Initials)
            .NotEmpty().WithMessage("Type three letters.")
            .Length(3).WithMessage("Initials are exactly three letters.")
            .Matches("^[A-Z]{3}$").WithMessage("Use the letters A to Z only.");
    }

    /// <summary>True when <paramref name="initials"/> passes the rule (used outside a form, e.g. the request header).</summary>
    public static bool IsValid(string? initials) =>
        initials is { Length: 3 } && initials.All(c => c is >= 'A' and <= 'Z');
}

/// <summary>A name for an ecosystem creature (Inspector "Rename").</summary>
public sealed class CreatureRenameInput
{
    public const int MaxLength = 24;
    public string Name { get; set; } = string.Empty;
}

public sealed class CreatureRenameInputValidator : AbstractValidator<CreatureRenameInput>
{
    public CreatureRenameInputValidator()
    {
        RuleFor(x => x.Name)
            .Must(n => !string.IsNullOrWhiteSpace(n)).WithMessage("Give it a name.")
            .Must(n => (n ?? string.Empty).Trim().Length <= CreatureRenameInput.MaxLength)
                .WithMessage($"Names are {CreatureRenameInput.MaxLength} characters or fewer.")
            .Must(n => (n ?? string.Empty).All(c => !char.IsControl(c))).WithMessage("Use ordinary characters only.");
    }
}

/// <summary>An ecosystem watch alert: "tell me when wolves fall below 5".</summary>
public sealed class EcoAlertInput
{
    public const int MaxValue = 400;

    /// <summary>-1 for every creature, else a species index.</summary>
    public int Species { get; set; } = 2;
    public string Op { get; set; } = "below";
    public int? Value { get; set; } = 5;
}

public sealed class EcoAlertInputValidator : AbstractValidator<EcoAlertInput>
{
    public EcoAlertInputValidator(int speciesCount)
    {
        RuleFor(x => x.Species)
            .InclusiveBetween(-1, Math.Max(-1, speciesCount - 1)).WithMessage("Pick which creatures to watch.");
        RuleFor(x => x.Op)
            .Must(op => op is "below" or "above").WithMessage("Pick below or above.");
        RuleFor(x => x.Value)
            .NotNull().WithMessage("Type how many.")
            .InclusiveBetween(0, EcoAlertInput.MaxValue).WithMessage($"Use a number from 0 to {EcoAlertInput.MaxValue}.");
    }
}
