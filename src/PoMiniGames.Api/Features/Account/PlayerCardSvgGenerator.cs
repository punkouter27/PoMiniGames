using System.Globalization;
using System.Security;
using System.Text;
using PoMiniGames.Domain.Models;

namespace PoMiniGames.Features.Account;

/// <summary>
/// Generates standalone, vector SVG "Competitive Player License" cards.
/// Fully self-contained with embedded fonts, CSS, gradients and theme tokens.
/// Compatible with GitHub README embeds, Discord image unfurls, and clipboard copies.
/// </summary>
public static class PlayerCardSvgGenerator
{
    public static string Generate(PlayerCardDto card)
    {
        var name = SecurityElement.Escape(card.DisplayName ?? "Guest");
        if (name.Length > 20) name = name[..18] + "…";
        var initials = SecurityElement.Escape(card.Initials ?? "P");
        var sigTitle = SecurityElement.Escape(card.SignatureGameTitle ?? "PoRacer");
        var sigIcon = card.SignatureGameIcon ?? "🏎️";
        var tierName = SecurityElement.Escape((card.TierName ?? "Silver").ToUpperInvariant());
        var tierColor = string.IsNullOrWhiteSpace(card.TierColorHex) ? "#c0c0c0" : card.TierColorHex;
        var nextTierName = SecurityElement.Escape(card.NextTierName ?? "Top Rank");
        var nextMinMmr = card.NextTierMinMmr.HasValue ? $"{card.NextTierMinMmr.Value:N0} MMR" : "MAX";
        var winRatePct = $"{card.WinRate * 100:0.#}%";
        var record = $"{card.Wins}W · {card.Losses}L · {card.Draws}D";
        var streak = card.CurrentStreak switch
        {
            > 0 => $"+{card.CurrentStreak} W",
            < 0 => $"{card.CurrentStreak} L",
            _ => "—"
        };
        var isMs = string.Equals(card.AccountKind, "microsoft", StringComparison.OrdinalIgnoreCase);
        var accountBadge = isMs ? "VERIFIED" : "GUEST";
        var accountBadgeColor = isMs ? "#00e5ff" : "#8892b0";

        var progressWidth = (int)Math.Clamp(Math.Round(card.TierProgress * 210), 4, 210);

        var sb = new StringBuilder(4096);
        sb.AppendLine("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 600 350\" width=\"600\" height=\"350\">");
        sb.AppendLine("  <defs>");
        sb.AppendLine("    <linearGradient id=\"bgGrad\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">");
        sb.AppendLine("      <stop offset=\"0%\" stop-color=\"#0a0f1d\"/>");
        sb.AppendLine("      <stop offset=\"50%\" stop-color=\"#10192e\"/>");
        sb.AppendLine("      <stop offset=\"100%\" stop-color=\"#070a14\"/>");
        sb.AppendLine("    </linearGradient>");
        sb.AppendLine("    <linearGradient id=\"cardBorder\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <stop offset=\"0%\" stop-color=\"{tierColor}\" stop-opacity=\"0.8\"/>");
        sb.AppendLine("      <stop offset=\"50%\" stop-color=\"#3b82f6\" stop-opacity=\"0.3\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <stop offset=\"100%\" stop-color=\"{tierColor}\" stop-opacity=\"0.6\"/>");
        sb.AppendLine("    </linearGradient>");
        sb.AppendLine("    <linearGradient id=\"progressGrad\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\">");
        sb.AppendLine("      <stop offset=\"0%\" stop-color=\"#3b82f6\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <stop offset=\"100%\" stop-color=\"{tierColor}\"/>");
        sb.AppendLine("    </linearGradient>");
        sb.AppendLine("    <filter id=\"glow\" x=\"-20%\" y=\"-20%\" width=\"140%\" height=\"140%\">");
        sb.AppendLine("      <feGaussianBlur stdDeviation=\"6\" result=\"blur\"/>");
        sb.AppendLine("      <feComposite in=\"SourceGraphic\" in2=\"blur\" operator=\"over\"/>");
        sb.AppendLine("    </filter>");
        sb.AppendLine("    <pattern id=\"grid\" width=\"24\" height=\"24\" patternUnits=\"userSpaceOnUse\">");
        sb.AppendLine("      <path d=\"M 24 0 L 0 0 0 24\" fill=\"none\" stroke=\"rgba(255,255,255,0.03)\" stroke-width=\"1\"/>");
        sb.AppendLine("    </pattern>");
        sb.AppendLine("  </defs>");

        sb.AppendLine("  <style>");
        sb.AppendLine("    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }");
        sb.AppendLine("    .sans { font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }");
        sb.AppendLine("  </style>");

        // Card Background
        sb.AppendLine("  <rect x=\"2\" y=\"2\" width=\"596\" height=\"346\" rx=\"20\" fill=\"url(#bgGrad)\" stroke=\"url(#cardBorder)\" stroke-width=\"2\"/>");
        sb.AppendLine("  <rect x=\"2\" y=\"2\" width=\"596\" height=\"346\" rx=\"20\" fill=\"url(#grid)\"/>");

        // Top accent
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"  <path d=\"M 20 2 Q 2 2 2 20 L 2 60 L 80 2 Z\" fill=\"{tierColor}\" opacity=\"0.15\"/>");
        sb.AppendLine("  <line x1=\"30\" y1=\"56\" x2=\"570\" y2=\"56\" stroke=\"rgba(255,255,255,0.08)\" stroke-width=\"1\"/>");

        // Header Section
        sb.AppendLine("  <text x=\"32\" y=\"38\" class=\"mono\" font-size=\"11\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"2\">POMINIGAMES · COMPETITIVE LICENSE</text>");

        // Verification Badge
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"  <rect x=\"480\" y=\"22\" width=\"88\" height=\"22\" rx=\"11\" fill=\"rgba(255,255,255,0.05)\" stroke=\"{accountBadgeColor}\" stroke-width=\"1\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"  <circle cx=\"493\" cy=\"33\" r=\"3.5\" fill=\"{accountBadgeColor}\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"  <text x=\"504\" y=\"37\" class=\"mono\" font-size=\"9.5\" font-weight=\"700\" fill=\"{accountBadgeColor}\" letter-spacing=\"1\">{accountBadge}</text>");

        // Avatar & Player Info
        sb.AppendLine("  <g transform=\"translate(32, 76)\">");
        sb.AppendLine("    <circle cx=\"40\" cy=\"40\" r=\"38\" fill=\"#1e293b\" stroke=\"url(#cardBorder)\" stroke-width=\"2.5\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"40\" y=\"48\" class=\"sans\" font-size=\"22\" font-weight=\"800\" fill=\"#ffffff\" text-anchor=\"middle\">{initials}</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"96\" y=\"32\" class=\"sans\" font-size=\"22\" font-weight=\"800\" fill=\"#ffffff\">{name}</text>");
        sb.AppendLine("    <rect x=\"96\" y=\"44\" width=\"130\" height=\"24\" rx=\"12\" fill=\"rgba(255,255,255,0.06)\" stroke=\"rgba(255,255,255,0.1)\" stroke-width=\"1\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"108\" y=\"60\" class=\"sans\" font-size=\"12\" font-weight=\"600\" fill=\"#94a3b8\">{sigIcon} {sigTitle}</text>");
        sb.AppendLine("  </g>");

        // Tier & MMR Section (Right)
        sb.AppendLine("  <g transform=\"translate(330, 76)\">");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <rect x=\"0\" y=\"4\" width=\"238\" height=\"32\" rx=\"8\" fill=\"rgba(255,255,255,0.04)\" stroke=\"{tierColor}\" stroke-opacity=\"0.4\" stroke-width=\"1\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"12\" y=\"25\" class=\"sans\" font-size=\"15\">{card.TierIcon}</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"36\" y=\"25\" class=\"mono\" font-size=\"13\" font-weight=\"800\" fill=\"{tierColor}\" letter-spacing=\"1\">{tierName} TIER</text>");
        sb.AppendLine("    <text x=\"226\" y=\"25\" class=\"mono\" font-size=\"12\" font-weight=\"700\" fill=\"#94a3b8\" text-anchor=\"end\">#ONLINE</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"0\" y=\"70\" class=\"sans\" font-size=\"34\" font-weight=\"900\" fill=\"#ffffff\" filter=\"url(#glow)\">{card.Mmr:N0}</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"110\" y=\"70\" class=\"mono\" font-size=\"14\" font-weight=\"700\" fill=\"{tierColor}\">MMR</text>");
        sb.AppendLine("    <rect x=\"0\" y=\"86\" width=\"238\" height=\"8\" rx=\"4\" fill=\"#1e293b\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <rect x=\"0\" y=\"86\" width=\"{progressWidth}\" height=\"8\" rx=\"4\" fill=\"url(#progressGrad)\"/>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"0\" y=\"106\" class=\"sans\" font-size=\"10.5\" font-weight=\"600\" fill=\"#64748b\">{card.TierProgress * 100:0}% to {nextTierName} ({nextMinMmr})</text>");
        sb.AppendLine("  </g>");

        // Divider
        sb.AppendLine("  <line x1=\"32\" y1=\"205\" x2=\"568\" y2=\"205\" stroke=\"rgba(255,255,255,0.08)\" stroke-width=\"1\"/>");

        // Stats Grid
        sb.AppendLine("  <g transform=\"translate(32, 222)\">");
        sb.AppendLine("    <g transform=\"translate(0, 0)\">");
        sb.AppendLine("      <text x=\"0\" y=\"14\" class=\"mono\" font-size=\"10\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"1\">WIN RATE</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <text x=\"0\" y=\"42\" class=\"sans\" font-size=\"24\" font-weight=\"800\" fill=\"#10b981\">{winRatePct}</text>");
        sb.AppendLine("    </g>");

        sb.AppendLine("    <g transform=\"translate(130, 0)\">");
        sb.AppendLine("      <text x=\"0\" y=\"14\" class=\"mono\" font-size=\"10\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"1\">ONLINE RECORD</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <text x=\"0\" y=\"40\" class=\"sans\" font-size=\"18\" font-weight=\"700\" fill=\"#e2e8f0\">{record}</text>");
        sb.AppendLine("    </g>");

        sb.AppendLine("    <g transform=\"translate(300, 0)\">");
        sb.AppendLine("      <text x=\"0\" y=\"14\" class=\"mono\" font-size=\"10\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"1\">PEAK MMR</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <text x=\"0\" y=\"40\" class=\"sans\" font-size=\"20\" font-weight=\"800\" fill=\"{tierColor}\">{card.PeakMmr:N0}</text>");
        sb.AppendLine("    </g>");

        sb.AppendLine("    <g transform=\"translate(440, 0)\">");
        sb.AppendLine("      <text x=\"0\" y=\"14\" class=\"mono\" font-size=\"10\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"1\">CURRENT STREAK</text>");
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"      <text x=\"0\" y=\"40\" class=\"sans\" font-size=\"20\" font-weight=\"800\" fill=\"#f59e0b\">{streak}</text>");
        sb.AppendLine("    </g>");
        sb.AppendLine("  </g>");

        // Footer / Recent Form
        sb.AppendLine("  <g transform=\"translate(32, 310)\">");
        sb.AppendLine("    <text x=\"0\" y=\"12\" class=\"mono\" font-size=\"9.5\" font-weight=\"700\" fill=\"#64748b\" letter-spacing=\"1\">RECENT FORM</text>");

        int formX = 90;
        if (card.RecentForm.Count == 0)
        {
            sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"{formX}\" y=\"12\" class=\"sans\" font-size=\"11\" fill=\"#475569\">No ranked matches yet</text>");
        }
        else
        {
            foreach (var match in card.RecentForm)
            {
                var (fill, label) = (match ?? "").ToLowerInvariant() switch
                {
                    "win" => ("#10b981", "W"),
                    "loss" => ("#ef4444", "L"),
                    _ => ("#64748b", "D")
                };
                sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <circle cx=\"{formX + 7}\" cy=\"9\" r=\"7\" fill=\"{fill}\"/>");
                sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"{formX + 7}\" y=\"12\" class=\"mono\" font-size=\"8\" font-weight=\"800\" fill=\"#ffffff\" text-anchor=\"middle\">{label}</text>");
                formX += 18;
            }
        }

        var memberSince = card.MemberSinceUtc.ToString("MMM yyyy", CultureInfo.InvariantCulture);
        sb.AppendLine(System.Globalization.CultureInfo.InvariantCulture, $"    <text x=\"536\" y=\"12\" class=\"mono\" font-size=\"9.5\" fill=\"#475569\" text-anchor=\"end\">ISSUED {SecurityElement.Escape(memberSince).ToUpperInvariant()}</text>");
        sb.AppendLine("  </g>");
        sb.AppendLine("</svg>");

        return sb.ToString();
    }
}

