using Amira.Domain;

namespace Amira.Client.WinUI;

public enum BotManagerAction
{
    Edit,
    Archive,
    Restore
}

public static class BotManagementDialogPolicy
{
    public static BotManagerAction? SecondaryAction(BotLifecycleState lifecycle) => lifecycle switch
    {
        BotLifecycleState.Active => BotManagerAction.Archive,
        BotLifecycleState.Archived => BotManagerAction.Restore,
        _ => throw new ArgumentOutOfRangeException(nameof(lifecycle), lifecycle, "Unsupported Bot lifecycle.")
    };

    public static string LifecycleLabel(BotLifecycleState lifecycle) => lifecycle switch
    {
        BotLifecycleState.Active => "Active",
        BotLifecycleState.Archived => "Archived",
        _ => throw new ArgumentOutOfRangeException(nameof(lifecycle), lifecycle, "Unsupported Bot lifecycle.")
    };

    public static string ActionLabel(BotManagerAction action) => action switch
    {
        BotManagerAction.Edit => "Edit",
        BotManagerAction.Archive => "Archive",
        BotManagerAction.Restore => "Restore",
        _ => throw new ArgumentOutOfRangeException(nameof(action), action, "Unsupported Bot manager action.")
    };
}
