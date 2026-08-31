using Amira.Client.WinUI;
using Amira.Domain;

namespace Amira.Client.WinUI.Tests;

public sealed class BotManagementDialogPolicyTests
{
    [Fact]
    public void Active_and_archived_Bots_offer_the_correct_secondary_action()
    {
        Assert.Equal(BotManagerAction.Archive, BotManagementDialogPolicy.SecondaryAction(BotLifecycleState.Active));
        Assert.Equal(BotManagerAction.Restore, BotManagementDialogPolicy.SecondaryAction(BotLifecycleState.Archived));
    }

    [Fact]
    public void Lifecycle_labels_are_user_facing_and_concise()
    {
        Assert.Equal("Active", BotManagementDialogPolicy.LifecycleLabel(BotLifecycleState.Active));
        Assert.Equal("Archived", BotManagementDialogPolicy.LifecycleLabel(BotLifecycleState.Archived));
    }

    [Fact]
    public void Invalid_lifecycle_and_action_values_are_programmer_errors()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => BotManagementDialogPolicy.SecondaryAction((BotLifecycleState)999));
        Assert.Throws<ArgumentOutOfRangeException>(() => BotManagementDialogPolicy.LifecycleLabel((BotLifecycleState)999));
        Assert.Throws<ArgumentOutOfRangeException>(() => BotManagementDialogPolicy.ActionLabel((BotManagerAction)999));
    }
}
