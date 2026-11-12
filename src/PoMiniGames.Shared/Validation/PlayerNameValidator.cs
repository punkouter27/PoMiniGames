using FluentValidation;

namespace PoMiniGames.Shared.Validation;

/// <summary>Display-name payload shared between API request validation and client forms.</summary>
public sealed class PlayerDisplayNameInput
{
    public string DisplayName { get; set; } = string.Empty;
}

/// <summary>Shared FluentValidation rules for player display names.</summary>
public sealed class PlayerDisplayNameValidator : AbstractValidator<PlayerDisplayNameInput>
{
    public PlayerDisplayNameValidator()
    {
        RuleFor(x => x.DisplayName)
            .NotEmpty().WithMessage("Display name is required.")
            .MaximumLength(32).WithMessage("Display name must be 32 characters or fewer.")
            .Matches("^[a-zA-Z0-9 _.-]+$").WithMessage("Display name contains unsupported characters.");
    }
}
