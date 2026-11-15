using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;

using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>
/// The visual half of the feedback stack, reachable from C#. Particles
/// (<c>gpuFx.js</c>, WebGL2 with a WebGPU compute backend) and screen feel
/// (<c>impactBus.js</c> — trauma shake, punch, flash, hitstop) without an
/// accompanying sound.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why this exists.</b> Both systems were reachable only as a side effect of
/// firing a named cue through <see cref="UiFeedbackService"/>, and a cue only
/// carries particles if its table entry happens to declare an <c>fx</c> block.
/// The consequence was that the Blazor-rendered games — TicTacToe, ConnectFive,
/// the quizzes — and every non-game surface had no way to emit a burst at all,
/// while the JS-engine games called <c>window.PoFx</c> directly and got the lot.
/// Nothing in C# referenced either global.
/// </para>
/// <para>
/// This is deliberately the *silent* surface. Anything that should make a noise
/// belongs in the cue vocabulary (<c>gameCues.js</c>) so the sound, the impact
/// envelope and the particles stay welded together — see
/// <see cref="UiFeedbackService.CueAsync"/>. Reach for this only when the visual
/// is the whole point: a rank climbing, a queue draining, a settings preview.
/// </para>
/// <para>
/// <b>Failure modes</b>: silent, like the rest of the feedback stack. The FX
/// globals are module scripts that may not have evaluated yet on the first
/// paint, WebGL2 may be unavailable, and <c>fxBootstrap.js</c> skips the
/// motion-heavy modules outright under reduced motion — so every call is a
/// best-effort no-op rather than a throw. The quality tier and reduce-motion
/// gates live inside the JS modules; callers here must not second-guess them.
/// </para>
/// </remarks>
public sealed class ScreenFxService
{
    private readonly IJSRuntime _js;

    public ScreenFxService(IJSRuntime js) => _js = js;

    /// <summary>Particle presets declared by <c>gpuFx.js</c>.</summary>
    public const string Sparks = "sparks";
    public const string Confetti = "confetti";
    public const string Dust = "dust";
    public const string Coins = "coins";
    public const string Smoke = "smoke";
    public const string Impact = "impact";

    /// <summary>
    /// Burst particles from the centre of an element, addressed by CSS selector.
    /// </summary>
    /// <param name="selector">CSS selector; the first match wins. A selector that
    /// matches nothing, or a hidden element, is a no-op inside gpuFx.</param>
    /// <param name="preset">One of the preset constants on this class.</param>
    /// <param name="scale">Scales count, speed and size together.</param>
    public ValueTask BurstAtAsync(string selector, string preset = Sparks, double scale = 1)
        => InvokeAsync("PoFx.burstAt", selector, new { preset, scale });

    /// <summary>
    /// Burst particles at a viewport position in CSS pixels. Use when the origin
    /// is computed rather than an element — a pointer position, a canvas hit.
    /// </summary>
    public ValueTask BurstAsync(double x, double y, string preset = Sparks, double scale = 1)
        => InvokeAsync("PoFx.burst", new { x, y, preset, scale });

    /// <summary>
    /// Confetti raining across the top of the viewport — the win celebration.
    /// This is the one effect that delegates to the WebGPU compute backend when
    /// it probed healthy, so it is also the cheapest high-volume option.
    /// </summary>
    public ValueTask CelebrateAsync(double scale = 1)
        => InvokeAsync("PoFx.celebrate", scale);

    /// <summary>
    /// Give confetti and sparks something to land on: they bounce off the top edge of each
    /// element's box and settle there instead of falling through it. Pass none to clear.
    /// The boxes are re-measured every frame, so an element that animates into place is
    /// followed. High tier only; the gate is inside gpuFx.
    /// </summary>
    public ValueTask CollideWithAsync(params ElementReference[] elements)
        => InvokeAsync("PoFx.setColliders", elements);

    /// <summary>Clear every live particle — use when tearing a game down.</summary>
    public ValueTask ClearAsync() => InvokeAsync("PoFx.clear");

    /// <summary>
    /// Fire a screen-feel envelope: shake, punch, flash and hitstop, mixed per
    /// kind. Accumulates rather than overwrites, so a flurry builds and then
    /// saturates.
    /// </summary>
    /// <param name="kind">tick | select | light | medium | heavy | win | lose.</param>
    /// <param name="scale">Multiplier for hits that vary continuously; clamped to
    /// 2.5 inside impactBus so a runaway value cannot lock the screen into a
    /// permanent earthquake.</param>
    public ValueTask ImpactAsync(string kind, double scale = 1)
        => InvokeAsync("PoImpact.impact", kind, scale);

    /// <summary>
    /// Freeze game time for a moment. Engines that read <c>PoImpact.getTimeScale()</c>
    /// slow to a near stop; skipped under reduced motion inside impactBus.
    /// </summary>
    public ValueTask HitstopAsync(int ms) => InvokeAsync("PoImpact.hitstop", ms);

    /// <summary>
    /// Assemble an element's text (or <paramref name="text"/>, drawn in the element's own
    /// font) out of a WebGPU particle swarm, then fade the real element back in under it.
    /// A no-op wherever the swarm cannot run: no WebGPU, the low tier, reduced motion.
    /// </summary>
    public ValueTask AssembleAsync(ElementReference element, string? text = null)
        => InvokeAsync("PoGpuWebGPU.assemble", element, new { text });

    /// <summary>
    /// A one-shot scale pop on an element — the cheap "this thing just changed"
    /// tell, driven by impactBus so it respects the same motion gate.
    /// </summary>
    public ValueTask PopAsync(string selector)
        => InvokeAsync("PoImpact.popSelector", selector);

    /// <summary>
    /// Add trauma directly, for callers that already compute their own hit
    /// weight and do not want a preset's envelope imposed on top.
    /// </summary>
    public ValueTask TraumaAsync(double amount)
        => InvokeAsync("PoImpact.addTrauma", amount);

    /// <summary>Moods understood by <c>paletteBus.js</c>.</summary>
    public const string Win = "win";
    public const string Lose = "lose";

    /// <summary>
    /// Pulse the whole page's accent tokens to a verdict mood for ~1.6 s, then
    /// fall back to the route's own palette.
    /// </summary>
    /// <param name="mood">Must be <see cref="Win"/> or <see cref="Lose"/> —
    /// <c>paletteBus.pulse</c> has no neutral mood and returns early on anything
    /// else, so there is no "just pulse the accent" call to make here.</param>
    public ValueTask PulseAsync(string mood)
        => InvokeAsync("PoPalette.pulse", mood);

    /// <summary>
    /// Fire-and-forget JS interop. Every FX entry point is optional chrome, so a
    /// missing global (module not yet evaluated, reduced motion pruned it in
    /// fxBootstrap) and a JS throw are both swallowed.
    /// </summary>
    private async ValueTask InvokeAsync(string identifier, params object?[] args)
    {
        try
        {
            await _js.InvokeVoidAsync(identifier, args);
        }
        catch
        {
            // Best-effort — never throw from a feedback path.
        }
    }
}
