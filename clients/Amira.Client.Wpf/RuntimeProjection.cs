using Amira.Domain;
using Amira.Runtime;

namespace Amira.Client.Wpf;

public sealed record RuntimeTurnProjection(BotTurnId TurnId, BotId BotId, string Text, TurnUsage? Usage, bool IsTerminal);

public sealed class RuntimeEventProjection
{
    private readonly Dictionary<BotTurnId, RuntimeTurnProjection> _turns = [];
    public int ActiveCount => _turns.Count;

    public RuntimeTurnProjection Apply(ChatRuntimeEvent runtimeEvent)
    {
        ArgumentNullException.ThrowIfNull(runtimeEvent);
        _turns.TryGetValue(runtimeEvent.TurnId, out RuntimeTurnProjection? current);
        RuntimeTurnProjection next = runtimeEvent switch
        {
            ChatRuntimeEvent.Started => new(runtimeEvent.TurnId, runtimeEvent.BotId, current?.Text ?? string.Empty, current?.Usage, false),
            ChatRuntimeEvent.TextDelta delta => new(runtimeEvent.TurnId, runtimeEvent.BotId, (current?.Text ?? string.Empty) + delta.Text, current?.Usage, false),
            ChatRuntimeEvent.UsageReported usage => new(runtimeEvent.TurnId, runtimeEvent.BotId, current?.Text ?? string.Empty, new TurnUsage(usage.Value.InputTokens, usage.Value.OutputTokens), false),
            ChatRuntimeEvent.Completed completed => new(runtimeEvent.TurnId, runtimeEvent.BotId, completed.Text, completed.Usage is null ? current?.Usage : new TurnUsage(completed.Usage.InputTokens, completed.Usage.OutputTokens), true),
            ChatRuntimeEvent.Failed or ChatRuntimeEvent.Cancelled => new(runtimeEvent.TurnId, runtimeEvent.BotId, current?.Text ?? string.Empty, current?.Usage, true),
            _ => throw new ArgumentOutOfRangeException(nameof(runtimeEvent))
        };
        _turns[runtimeEvent.TurnId] = next;
        return next;
    }

    public void Forget(BotTurnId turnId) => _turns.Remove(turnId);
}
