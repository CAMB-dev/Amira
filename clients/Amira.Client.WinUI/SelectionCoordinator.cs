using Amira.Domain;

namespace Amira.Client.WinUI;

public sealed class SelectionCoordinator
{
    private long _generation;
    public long Next() => Interlocked.Increment(ref _generation);
    public bool IsCurrent(long generation, BotId selectedBotId, BotId expectedBotId) => generation == Volatile.Read(ref _generation) && selectedBotId == expectedBotId;
}
