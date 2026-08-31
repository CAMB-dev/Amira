using Amira.Client.WinUI;
using Amira.Contracts;
using Amira.Domain;

namespace Amira.Client.WinUI.Tests;

public sealed class TurnActivityPolicyTests
{
    [Fact]
    public void Stop_requested_turn_has_no_stop_action()
    {
        TurnView turn = Create(BotTurnStatus.Running, stopRequested: true);

        Assert.False(TurnActivityPolicy.CanStop(turn));
        Assert.False(TurnActivityPolicy.HasAnyAction(turn));
    }

    [Fact]
    public void Active_turn_can_stop_and_terminal_failure_can_retry()
    {
        Assert.True(TurnActivityPolicy.CanStop(Create(BotTurnStatus.Queued, stopRequested: false)));
        Assert.True(TurnActivityPolicy.CanRetry(Create(BotTurnStatus.Failed, stopRequested: false)));
        Assert.True(TurnActivityPolicy.HasAnyAction(Create(BotTurnStatus.Cancelled, stopRequested: true)));
    }

    private static TurnView Create(BotTurnStatus status, bool stopRequested) => new(
        BotTurnId.New(),
        BotId.New(),
        DirectChatId.New(),
        ModelProfileId.New(),
        ProviderConnectionId.New(),
        ProviderProtocol.OpenAIChatCompatible,
        "test-model",
        1,
        status,
        DateTimeOffset.UtcNow,
        null,
        null,
        stopRequested,
        null,
        null,
        null);
}
