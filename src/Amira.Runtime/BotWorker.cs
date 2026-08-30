using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Runtime;

internal sealed class BotWorker(
    BasicChatRuntime runtime,
    IChatStore chatStore,
    WorkspaceId workspaceId,
    BotId botId,
    BotWorkerOptions options) : IBotWorker
{
    private readonly object _lifecycleGate = new();
    private readonly CancellationTokenSource _shutdown = new();
    private readonly TaskCompletionSource _stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly object _wakeGate = new();
    private TaskCompletionSource<bool> _wakeGeneration = NewWakeGeneration();
    private bool _wakePending;
    private WorkerState _state;

    public BotId BotId { get; } = botId;

    public Task RunAsync(IChatRuntimeEventSink sink, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(sink);
        lock (_lifecycleGate)
        {
            if (_state != WorkerState.Created)
            {
                throw NotRunnable();
            }

            _state = WorkerState.Running;
        }

        return RunCoreAsync(sink, cancellationToken);
    }

    public void Wake()
    {
        lock (_lifecycleGate)
        {
            if (_state is WorkerState.Stopped or WorkerState.Disposed)
            {
                throw NotRunnable();
            }

            SignalWake();
        }
    }

    public async ValueTask DisposeAsync()
    {
        bool initiator;
        WorkerState previous;
        lock (_lifecycleGate)
        {
            initiator = _state != WorkerState.Disposed;
            previous = _state;
            if (initiator)
            {
                _state = WorkerState.Disposed;
            }
        }

        if (!initiator)
        {
            await _disposed.Task.ConfigureAwait(false);
            return;
        }

        try
        {
            if (previous == WorkerState.Created)
            {
                _stopped.TrySetResult();
            }

            _shutdown.Cancel();
            SignalWake();
            await _stopped.Task.ConfigureAwait(false);
            _shutdown.Dispose();
        }
        finally
        {
            _disposed.TrySetResult();
        }
    }

    private async Task RunCoreAsync(IChatRuntimeEventSink sink, CancellationToken externalCancellation)
    {
        try
        {
            using var runCancellation = CancellationTokenSource.CreateLinkedTokenSource(
                externalCancellation,
                _shutdown.Token);
            try
            {
                await RunLoopAsync(sink, runCancellation.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (runCancellation.IsCancellationRequested)
            {
                // Host cancellation and disposal are normal worker shutdown paths.
            }
        }
        finally
        {
            lock (_lifecycleGate)
            {
                if (_state == WorkerState.Running)
                {
                    _state = WorkerState.Stopped;
                }
            }

            _stopped.TrySetResult();
        }
    }

    private async Task RunLoopAsync(IChatRuntimeEventSink sink, CancellationToken cancellationToken)
    {
        TimeSpan idleDelay = options.InitialIdleDelay;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            ClaimedTurn? claimed = await chatStore.TryClaimNextTurnAsync(BotId, cancellationToken).ConfigureAwait(false);
            if (claimed is null)
            {
                bool woken = await WaitForWakeOrDelayAsync(idleDelay, cancellationToken).ConfigureAwait(false);
                idleDelay = woken ? options.InitialIdleDelay : NextIdleDelay(idleDelay);
                continue;
            }

            idleDelay = options.InitialIdleDelay;
            await foreach (ChatRuntimeEvent runtimeEvent in runtime
                .ExecuteClaimedAsync(workspaceId, claimed, cancellationToken)
                .ConfigureAwait(false))
            {
                await sink.PublishAsync(runtimeEvent, cancellationToken).ConfigureAwait(false);
            }
        }
    }

    private async Task<bool> WaitForWakeOrDelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        TaskCompletionSource<bool> observedGeneration;
        lock (_wakeGate)
        {
            if (_wakePending)
            {
                ConsumeWakeGeneration();
                return true;
            }

            observedGeneration = _wakeGeneration;
        }

        using var delayCancellation = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task<bool> wakeTask = observedGeneration.Task;
        Task delayTask = Task.Delay(delay, options.TimeProvider, delayCancellation.Token);
        Task winner = await Task.WhenAny(wakeTask, delayTask).ConfigureAwait(false);

        if (ReferenceEquals(winner, wakeTask))
        {
            _ = await wakeTask.ConfigureAwait(false);
            lock (_wakeGate)
            {
                if (ReferenceEquals(_wakeGeneration, observedGeneration) && _wakePending)
                {
                    ConsumeWakeGeneration();
                }
            }

            delayCancellation.Cancel();
            await IgnoreRaceCancellationAsync(delayTask, delayCancellation.Token).ConfigureAwait(false);
            return true;
        }

        await delayTask.ConfigureAwait(false);
        lock (_wakeGate)
        {
            if (ReferenceEquals(_wakeGeneration, observedGeneration) && _wakePending)
            {
                ConsumeWakeGeneration();
                return true;
            }

            if (ReferenceEquals(_wakeGeneration, observedGeneration))
            {
                _wakeGeneration = NewWakeGeneration();
            }
        }

        observedGeneration.TrySetResult(false);
        return false;
    }

    private static async Task IgnoreRaceCancellationAsync(Task task, CancellationToken raceCancellation)
    {
        try
        {
            await task.ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (raceCancellation.IsCancellationRequested)
        {
        }
    }

    private TimeSpan NextIdleDelay(TimeSpan current)
    {
        long maximumTicks = options.MaximumIdleDelay.Ticks;
        long nextTicks = current.Ticks > maximumTicks / 2
            ? maximumTicks
            : current.Ticks * 2;
        return TimeSpan.FromTicks(Math.Min(nextTicks, maximumTicks));
    }

    private void SignalWake()
    {
        lock (_wakeGate)
        {
            if (!_wakePending)
            {
                _wakePending = true;
                _wakeGeneration.TrySetResult(true);
            }
        }
    }

    private void ConsumeWakeGeneration()
    {
        _wakePending = false;
        _wakeGeneration = NewWakeGeneration();
    }

    private static TaskCompletionSource<bool> NewWakeGeneration() =>
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    private static AmiraException NotRunnable() => new(new(
        AmiraErrorCodes.BotWorkerNotRunnable,
        ErrorCategory.Concurrency,
        "A Bot worker can run only once and cannot be used after it has stopped or been disposed."));

    private enum WorkerState
    {
        Created,
        Running,
        Stopped,
        Disposed,
    }
}
