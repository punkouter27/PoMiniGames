using Radzen;

namespace PoMiniGamesClient.Services.Ui;

/// <summary>Shared NotificationService / DialogService wrappers alongside ToastService.</summary>
public sealed class DialogNotificationHelper(
    ToastService toasts,
    NotificationService notifications,
    DialogService dialogs)
{
    public void NotifySuccess(string message)
    {
        toasts.Show(message, ToastType.Success);
        notifications.Notify(NotificationSeverity.Success, message);
    }

    public void NotifyError(string message)
    {
        toasts.Show(message, ToastType.Error);
        notifications.Notify(NotificationSeverity.Error, message);
    }

    public Task<bool?> ConfirmAsync(string title, string message, string okText = "Confirm", string cancelText = "Cancel") =>
        dialogs.Confirm(message, title, new ConfirmOptions { OkButtonText = okText, CancelButtonText = cancelText });
}
