using FluentValidation;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Shared.Validation;

/// <summary>Bounds every field of a report-card request; the series are capped and range-checked.</summary>
public sealed class PoCapitolReportCardRequestValidator : AbstractValidator<PoCapitolReportCardRequest>
{
    private const string Label = "^[A-Za-z0-9 _.:-]{0,32}$";

    public PoCapitolReportCardRequestValidator()
    {
        RuleFor(x => x.Outcome).NotNull().Matches(Label).WithMessage("Outcome is 32 plain characters or fewer.");
        RuleFor(x => x.Role).Must(r => r is "raider" or "police" or "none").WithMessage("Role is raider, police or none.");
        RuleFor(x => x.Mode).Must(m => m is "solo" or "demo").WithMessage("Mode is solo or demo.");
        RuleFor(x => x.Difficulty).NotNull().Matches(Label).WithMessage("Difficulty is 32 plain characters or fewer.");
        RuleFor(x => x.Clock).NotNull().Matches("^[0-9apm: ]{0,12}$").WithMessage("Clock looks like 3:12 pm.");
        RuleFor(x => x.Minutes).InclusiveBetween(0, 600);
        RuleFor(x => x.Standing).InclusiveBetween(0, 10_000);
        RuleFor(x => x.Police).InclusiveBetween(0, 10_000);
        RuleFor(x => x.Casualties).InclusiveBetween(0, 10_000);
        RuleFor(x => x.LowestIntegrity).InclusiveBetween(0, 100);
        RuleFor(x => x.PeakPressure).InclusiveBetween(0, 1_000);
        RuleFor(x => x.Milestones).InclusiveBetween(0, 100);

        RuleFor(x => x.Integrity).NotNull().Must(a => a is { Length: <= PoCapitolReportCardRequest.MaxSamples })
            .WithMessage($"At most {PoCapitolReportCardRequest.MaxSamples} integrity samples.");
        RuleFor(x => x.Pressure).NotNull().Must(a => a is { Length: <= PoCapitolReportCardRequest.MaxSamples })
            .WithMessage($"At most {PoCapitolReportCardRequest.MaxSamples} pressure samples.");
        RuleFor(x => x.FrontZ).NotNull().Must(a => a is { Length: <= PoCapitolReportCardRequest.MaxSamples })
            .WithMessage($"At most {PoCapitolReportCardRequest.MaxSamples} front-line samples.");

        RuleForEach(x => x.Integrity).InclusiveBetween(0f, 100f).When(x => x.Integrity is { Length: <= PoCapitolReportCardRequest.MaxSamples });
        RuleForEach(x => x.Pressure).InclusiveBetween(0f, 1_000f).When(x => x.Pressure is { Length: <= PoCapitolReportCardRequest.MaxSamples });
        RuleForEach(x => x.FrontZ).InclusiveBetween(-200f, 300f).When(x => x.FrontZ is { Length: <= PoCapitolReportCardRequest.MaxSamples });
    }
}
