using System.Globalization;
using System.Reflection;
using PoMiniGames.Shared.Games;
using Silk.NET.Maths;
using SkiaSharp;

namespace PoMiniGames.Features.PoCapitol;

/// <summary>
/// Draws the after-action report card with SkiaSharp. The route strip projects campus world
/// coordinates onto the card with a Silk.NET.Maths <see cref="Matrix3X2{T}"/>.
/// </summary>
internal static class PoCapitolReportCardRenderer
{
    public const int Width = 1200;
    public const int Height = 630;

    /// <summary>Campus areas: name, world x/z centre, width (x) and depth (z). z grows toward the lawn.</summary>
    internal static readonly (string Name, float X, float Z, float W, float D)[] Areas =
    [
        ("West front grounds", 0f, 61f, 76f, 94f),
        ("Crypt", 0f, 5.5f, 18f, 19f),
        ("Rotunda", 0f, -14f, 34f, 24f),
        ("Doorway", 0f, -27.5f, 8f, 5f),
        ("Statuary Hall", 0f, -37f, 24f, 16f),
        ("House corridor", 0f, -48.5f, 8f, 9f),
    ];

    private static readonly Lazy<SKTypeface> Face = new(LoadFace);

    private static SKTypeface LoadFace()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PoCapitol.Inter.ttf")
            ?? throw new InvalidOperationException("Embedded report-card font is missing.");
        return SKTypeface.FromStream(stream) ?? throw new InvalidOperationException("Report-card font failed to load.");
    }

    private static readonly SKColor Bg = SKColor.Parse("#0d1520");
    private static readonly SKColor Panel = SKColor.Parse("#16222f");
    private static readonly SKColor Grid = SKColor.Parse("#2a3d55");
    private static readonly SKColor Muted = SKColor.Parse("#7f95ad");
    private static readonly SKColor Text = SKColor.Parse("#e8eef5");
    private static readonly SKColor Blue = SKColor.Parse("#54a0ff");
    private static readonly SKColor Orange = SKColor.Parse("#ff9f43");
    private static readonly SKColor Gold = SKColor.Parse("#c9a227");

    public static byte[] Render(PoCapitolReportCardRequest r)
    {
        using var surface = SKSurface.Create(new SKImageInfo(Width, Height, SKColorType.Rgba8888, SKAlphaType.Premul));
        var c = surface.Canvas;
        c.Clear(Bg);

        // Header.
        Draw(c, "After-action report", 40, 30, 38, Text, bold: true);
        var (outcomeText, outcomeColor) = OutcomeStyle(r.Outcome);
        Draw(c, outcomeText, 40, 78, 26, outcomeColor, bold: true);
        var sub = string.Join("  ·  ", new[]
        {
            r.Mode.ToUpperInvariant(), r.Role == "none" ? "OBSERVER" : r.Role.ToUpperInvariant(),
            r.Difficulty.ToUpperInvariant(), r.Clock, $"{r.Minutes:0.#} min",
        }.Where(s => s.Length > 0));
        Draw(c, sub, Width - 40, 40, 18, Muted, SKTextAlign.Right);

        // Stat row.
        var stats = new (string Label, string Value)[]
        {
            ("STANDING", r.Standing.ToString(CultureInfo.InvariantCulture)), ("POLICE", r.Police.ToString(CultureInfo.InvariantCulture)),
            ("CASUALTIES", r.Casualties.ToString(CultureInfo.InvariantCulture)), ("LOWEST LINE", $"{r.LowestIntegrity:0}%"),
            ("PEAK PRESSURE", $"{r.PeakPressure:0.#}"), ("MILESTONES", r.Milestones.ToString(CultureInfo.InvariantCulture)),
        };
        const float gap = 12f, rowTop = 124f, rowH = 76f;
        var tileW = (Width - 80 - gap * (stats.Length - 1)) / stats.Length;
        for (var i = 0; i < stats.Length; i++)
        {
            var x = 40 + i * (tileW + gap);
            Fill(c, Panel, new SKRect(x, rowTop, x + tileW, rowTop + rowH), 8);
            Draw(c, stats[i].Label, x + 14, rowTop + 10, 13, Muted);
            Draw(c, stats[i].Value, x + 14, rowTop + 32, 30, Text, bold: true);
        }

        DrawChart(c, r, new SKRect(40, 222, Width - 40, 424));
        DrawRoute(c, r, new SKRect(40, 446, Width - 40, Height - 24));

        c.Flush();
        using var image = surface.Snapshot();
        using var data = image.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private static (string, SKColor) OutcomeStyle(string outcome)
    {
        var o = outcome.Trim().ToLowerInvariant();
        var label = o.Length == 0 ? "No outcome recorded" : char.ToUpperInvariant(o[0]) + o[1..];
        var color = o switch
        {
            _ when o.Contains("win") || o.Contains("breach") || o.Contains("held") => SKColor.Parse("#5fd38d"),
            _ when o.Contains("loss") || o.Contains("lost") || o.Contains("fail") => SKColor.Parse("#ff6b6b"),
            _ => Orange,
        };
        return (label, color);
    }

    private static void DrawChart(SKCanvas c, PoCapitolReportCardRequest r, SKRect box)
    {
        Fill(c, Panel, box, 8);
        Draw(c, "LINE INTEGRITY", box.Left + 16, box.Top + 10, 13, Blue, bold: true);
        Draw(c, "CROWD PRESSURE", box.Left + 150, box.Top + 10, 13, Orange, bold: true);

        var plot = new SKRect(box.Left + 52, box.Top + 36, box.Right - 16, box.Bottom - 16);
        using var gridPaint = new SKPaint { Color = Grid, StrokeWidth = 1, IsAntialias = true };
        foreach (var v in new[] { 0, 50, 100 })
        {
            var y = plot.Bottom - v / 100f * plot.Height;
            c.DrawLine(plot.Left, y, plot.Right, y, gridPaint);
            Draw(c, v.ToString(CultureInfo.InvariantCulture), plot.Left - 8, y - 7, 12, Muted, SKTextAlign.Right);
        }

        var maxPressure = Math.Max(1f, r.Pressure.Length == 0 ? 1f : r.Pressure.Max());
        Polyline(c, r.Pressure, plot, maxPressure, Orange, 2f, dashed: true);
        Polyline(c, r.Integrity, plot, 100f, Blue, 3f, dashed: false);
    }

    private static void Polyline(SKCanvas c, float[] values, SKRect plot, float max, SKColor color, float width, bool dashed)
    {
        if (values.Length < 2) return;
        var builder = new SKPathBuilder();
        for (var i = 0; i < values.Length; i++)
        {
            var x = plot.Left + i / (float)(values.Length - 1) * plot.Width;
            var y = plot.Bottom - Math.Clamp(values[i] / max, 0f, 1f) * plot.Height;
            if (i == 0) builder.MoveTo(x, y); else builder.LineTo(x, y);
        }
        using var path = builder.Detach();
        using var paint = new SKPaint { Color = color, Style = SKPaintStyle.Stroke, StrokeWidth = width, IsAntialias = true, StrokeJoin = SKStrokeJoin.Round };
        if (dashed) paint.PathEffect = SKPathEffect.CreateDash([8f, 6f], 0);
        c.DrawPath(path, paint);
    }

    /// <summary>
    /// World (x, z) to card pixels: z runs left to right from the lawn to the House corridor and
    /// x runs down the strip. Built as rotate-scale-translate matrix from Silk.NET.Maths.
    /// </summary>
    internal static Matrix3X2<float> RouteTransform(SKRect strip)
    {
        const float zLawn = 108f, zHouse = -53f, halfX = 38f;
        var sz = strip.Width / (zLawn - zHouse);
        var sx = strip.Height / (2 * halfX);
        // Row-vector convention: card.x = -z * sz, card.y = x * sx.
        return new Matrix3X2<float>(0f, sx, -sz, 0f, strip.Left + zLawn * sz, strip.Top + halfX * sx);
    }

    private static void DrawRoute(SKCanvas c, PoCapitolReportCardRequest r, SKRect box)
    {
        Draw(c, "ROUTE · lawn to House chamber", box.Left, box.Top, 13, Muted, bold: true);
        var strip = new SKRect(box.Left, box.Top + 24, box.Right, box.Bottom);
        var m = RouteTransform(strip);
        SKPoint P(float x, float z)
        {
            var v = Vector2D.Transform(new Vector2D<float>(x, z), m);
            return new SKPoint(v.X, v.Y);
        }

        using var edge = new SKPaint { Color = Grid, Style = SKPaintStyle.Stroke, StrokeWidth = 1.5f, IsAntialias = true };
        using var fill = new SKPaint { Color = Panel, IsAntialias = true };
        foreach (var (name, x, z, w, d) in Areas)
        {
            var a = P(x - w / 2, z - d / 2);
            var b = P(x + w / 2, z + d / 2);
            var rect = new SKRect(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));
            c.DrawRoundRect(rect, 4, 4, fill);
            c.DrawRoundRect(rect, 4, 4, edge);
            if (rect.Width > 70) Draw(c, name, rect.MidX, rect.MidY - 8, 12, Muted, SKTextAlign.Center);
        }

        if (r.FrontZ.Length == 0) return;
        var start = r.FrontZ[0];
        var deepest = r.FrontZ.Min();
        var end = r.FrontZ[^1];
        var pStart = P(0, start);
        var pDeep = P(0, deepest);
        if (pDeep.X - pStart.X > 1f)
        {
            using var band = new SKPaint
            {
                IsAntialias = true,
                Shader = SKShader.CreateLinearGradient(new SKPoint(pStart.X, 0), new SKPoint(pDeep.X, 0),
                    [Orange.WithAlpha(40), Orange.WithAlpha(190)], SKShaderTileMode.Clamp),
            };
            c.DrawRect(new SKRect(pStart.X, strip.Top + 4, pDeep.X, strip.Bottom - 4), band);
        }
        using var line = new SKPaint { Color = Gold, StrokeWidth = 3, IsAntialias = true };
        var pEnd = P(0, end);
        c.DrawLine(pEnd.X, strip.Top, pEnd.X, strip.Bottom, line);
        var pushed = Math.Max(0f, start - end);
        Draw(c, $"police line pushed back {pushed:0} m", Math.Clamp(pEnd.X, box.Left + 150, box.Right - 150), strip.Bottom - 22, 13, Gold, SKTextAlign.Center, bold: true);
    }

    private static void Fill(SKCanvas c, SKColor color, SKRect rect, float radius)
    {
        using var paint = new SKPaint { Color = color, IsAntialias = true };
        c.DrawRoundRect(rect, radius, radius, paint);
    }

    /// <summary>Draws text with its top edge at <paramref name="top"/> (not the baseline).</summary>
    private static void Draw(SKCanvas c, string text, float x, float top, float size, SKColor color,
        SKTextAlign align = SKTextAlign.Left, bool bold = false)
    {
        using var font = new SKFont(Face.Value, size) { Embolden = bold, Edging = SKFontEdging.SubpixelAntialias };
        using var paint = new SKPaint { Color = color, IsAntialias = true };
        c.DrawText(text, x, top + size * 0.9f, align, font, paint);
    }
}
