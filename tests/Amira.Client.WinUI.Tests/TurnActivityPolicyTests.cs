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

    [Fact]
    public void Default_selection_prefers_a_live_turn_over_a_newer_retryable_turn()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView newestCompleted = Create(BotTurnStatus.Completed, stopRequested: false, now);
        TurnView olderFailed = Create(BotTurnStatus.Failed, stopRequested: false, now.AddSeconds(-1));
        TurnView newerRunning = Create(BotTurnStatus.Running, stopRequested: false, now.AddSeconds(-2));
        TurnView oldestRunning = Create(BotTurnStatus.Running, stopRequested: false, now.AddSeconds(-3));

        TurnView selected = Assert.IsType<TurnView>(
            TurnActivityPolicy.SelectDefault([oldestRunning, newestCompleted, newerRunning, olderFailed]));

        Assert.Equal(newerRunning.TurnId, selected.TurnId);
    }

    [Fact]
    public void Default_selection_prefers_the_newest_retryable_turn_when_no_turn_is_live()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView newestCompleted = Create(BotTurnStatus.Completed, stopRequested: false, now);
        TurnView newerFailed = Create(BotTurnStatus.Failed, stopRequested: false, now.AddSeconds(-1));
        TurnView olderCancelled = Create(BotTurnStatus.Cancelled, stopRequested: false, now.AddSeconds(-2));

        TurnView selected = Assert.IsType<TurnView>(
            TurnActivityPolicy.SelectDefault([olderCancelled, newestCompleted, newerFailed]));

        Assert.Equal(newerFailed.TurnId, selected.TurnId);
    }

    [Fact]
    public void Default_selection_falls_back_to_the_newest_turn_when_none_are_actionable()
    {
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView older = Create(BotTurnStatus.Completed, stopRequested: false, now.AddSeconds(-1));
        TurnView newer = Create(BotTurnStatus.Completed, stopRequested: false, now);

        TurnView selected = Assert.IsType<TurnView>(TurnActivityPolicy.SelectDefault([older, newer]));

        Assert.Equal(newer.TurnId, selected.TurnId);
    }

    private static TurnView Create(BotTurnStatus status, bool stopRequested, DateTimeOffset? queuedAt = null) => new(
        BotTurnId.New(),
        BotId.New(),
        DirectChatId.New(),
        ModelProfileId.New(),
        ProviderConnectionId.New(),
        ProviderProtocol.OpenAIChatCompatible,
        "test-model",
        1,
        status,
        queuedAt ?? DateTimeOffset.UtcNow,
        null,
        null,
        null,
        stopRequested,
        null,
        null,
        null);
}
