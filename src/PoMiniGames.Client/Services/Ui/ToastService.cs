using PoMiniGamesClient.Services.Auth;
using PoMiniGamesClient.Services.Http;
using PoMiniGamesClient.Services.Interop;
using PoMiniGamesClient.Services.Play;
using PoMiniGamesClient.Services.Ui;

namespace PoMiniGamesClient.Services.Ui;

public enum ToastType
{
    Info,
    Error,
    Success,
    Warning
}

public class ToastItem
{
    public int Id { get; init; }
    public string Message { get; init; } = "";
    public ToastType Type { get; init; }
    /// <summary>Label for an optional action button; null renders a plain toast.</summary>
    public string? ActionLabel { get; init; }
    /// <summary>Invoked when the action button is pressed.</summary>
    public Func<Task>? Action { get; init; }

    /// <summary>
    /// True until a layout has fired this toast's entry effect. The audio cue
    /// goes out from <see cref="ToastService"/> the moment the toast is created,
    /// because sound needs no DOM — but a burst positioned *on* the toast cannot
    /// fire until Blazor has actually rendered it. The layout claims this flag in
    /// its after-render pass; see <c>MainLayout.razor</c>.
    /// </summary>
    public bool FxPending { get; set; } = true;
}

/// <summary>
/// The app's notification queue — and, since every notification is a moment worth
/// hearing, the place each one's audio cue is fired from.
/// </summary>
/// <remarks>
/// <para>
/// <b>Why the cue lives here and not in the layout.</b> Four layouts render a
/// toast stack (MainLayout, EmptyLayout, BareLayout) and a cue
/// fired from any one of them would be silent under the other three. Firing on
/// creation instead makes the coverage structural: a toast cannot exist without
/// having been announced.
/// </para>
/// <para>
/// The <i>visual</i> half deliberately does not live here — a burst positioned on
/// the toast needs the element, which does not exist until the next render. That
/// is what <see cref="ToastItem.FxPending"/> hands to the layout.
/// </para>
/// </remarks>
public class ToastService
{
    private readonly List<ToastItem> _toasts = [];
    private readonly UiFeedbackService _feedback;
    private int _nextId;

    public ToastService(UiFeedbackService feedback) => _feedback = feedback;

    public IReadOnlyList<ToastItem> Toasts => _toasts;

    public event Action? StateChanged;

    /// <summary>
    /// The cue each toast type announces itself with, from the shared "ui" scope
    /// in <c>gameCues.js</c>.
    /// </summary>
    /// <remarks>
    /// <list type="bullet">
    /// <item><b>Success</b> → "chime", the only ui cue carrying a particle burst —
    /// a success toast is the one kind worth a visual flourish.</item>
    /// <item><b>Error</b> → "error", two square voices 11 Hz apart; the beating is
    /// dissonant in a way a single detuned tone is not.</item>
    /// <item><b>Warning</b> → "back", a falling sweep. Players read descending as
    /// negative without being told, and it is softer than the error buzz, which
    /// keeps the two distinguishable.</item>
    /// <item><b>Info</b> → "toggle", 30 ms. Info toasts are the common case and a
    /// louder cue would fatigue.</item>
    /// </list>
    /// </remarks>
    private static string CueFor(ToastType type) => type switch
    {
        ToastType.Success => "chime",
        ToastType.Error => "error",
        ToastType.Warning => "back",
        _ => "toggle",
    };

    public void Show(string message, ToastType type = ToastType.Info)
    {
        var id = ++_nextId;
        var toast = new ToastItem { Id = id, Message = message, Type = type };
        _toasts.Add(toast);
        Announce(type);
        StateChanged?.Invoke();

        _ = RemoveAfterDelay(id, 5000);
    }

    /// <summary>
    /// Fire-and-forget the toast's cue. Not awaited because <see cref="Show"/> is
    /// synchronous by contract — a hundred call sites treat showing a toast as a
    /// statement, not an operation — and feedback is best-effort anyway:
    /// <see cref="UiFeedbackService"/> swallows its own failures.
    /// </summary>
    private void Announce(ToastType type) => _ = _feedback.CueAsync("ui", CueFor(type)).AsTask();

    /// <summary>
    /// A toast the user must act on or dismiss — it never auto-expires.
    /// </summary>
    /// <remarks>
    /// Used for the service-worker update prompt, where the action is not optional
    /// decoration: a waiting worker does not activate on an ordinary reload, so
    /// without pressing this the player stays on the old build indefinitely. A
    /// 5-second auto-dismiss would routinely expire before it was read.
    /// </remarks>
    public void ShowAction(string message, string actionLabel, Func<Task> action, ToastType type = ToastType.Info)
    {
        var toast = new ToastItem
        {
            Id = ++_nextId,
            Message = message,
            Type = type,
            ActionLabel = actionLabel,
            Action = action,
        };
        _toasts.Add(toast);
        Announce(type);
        StateChanged?.Invoke();
    }

    public void Dismiss(int id)
    {
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }

    /// <summary>
    /// Dismiss every active toast. Used by the kiosk reel's entry point so a
    /// persistent toast (the PWA "Update now" prompt, an error toast from the
    /// previous page) does not survive into the attract loop and compete for
    /// taps with the reel's Skip/Exit controls.
    /// </summary>
    public void DismissAll()
    {
        if (_toasts.Count == 0) return;
        _toasts.Clear();
        StateChanged?.Invoke();
    }

    private async Task RemoveAfterDelay(int id, int delayMs)
    {
        await Task.Delay(delayMs);
        _toasts.RemoveAll(t => t.Id == id);
        StateChanged?.Invoke();
    }
}
