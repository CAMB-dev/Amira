using Amira.Contracts;
using Amira.Domain;

namespace Amira.Client.WinUI;

public static class TurnActivityPolicy
{
    public static bool CanStop(TurnView turn) =>
        !turn.StopRequested && turn.Status is BotTurnStatus.Queued or BotTurnStatus.Running;

    public static bool CanRetry(TurnView turn) =>
        turn.Status is BotTurnStatus.Failed or BotTurnStatus.Cancelled;

    public static bool HasAnyAction(TurnView turn) => CanStop(turn) || CanRetry(turn);

    public static TurnView? SelectDefault(IEnumerable<TurnView> turns)
    {
        ArgumentNullException.ThrowIfNull(turns);
        TurnView[] newestFirst =
        [
            .. turns
                .OrderByDescending(turn => turn.QueuedAt)
                .ThenByDescending(turn => turn.TurnId.Value, StringComparer.Ordinal),
        ];
        return newestFirst.FirstOrDefault(CanStop)
            ?? newestFirst.FirstOrDefault(CanRetry)
            ?? newestFirst.FirstOrDefault();
    }
}
