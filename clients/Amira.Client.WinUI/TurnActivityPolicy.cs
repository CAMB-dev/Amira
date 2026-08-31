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
}
