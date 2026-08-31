using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;
using Microsoft.Extensions.Logging;

namespace Amira.Client.Composition.Windows;

public sealed class BotWorkerRegistry
{
    private readonly object _gate = new();
    private readonly Dictionary<BotId, Entry> _entries = [];
    private readonly TaskCompletionSource _disposed = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private bool _stopping;

    private readonly ILogger<BotWorkerRegistry> _logger;

    public BotWorkerRegistry(BasicChatRuntime runtime, WorkspaceId workspaceId, IChatRuntimeEventSink sink, ILogger<BotWorkerRegistry> logger)
    {
        ArgumentNullException.ThrowIfNull(runtime);
        ArgumentNullException.ThrowIfNull(sink);
        ArgumentNullException.ThrowIfNull(logger);
        _runtime = runtime;
        _workspaceId = workspaceId;
        _sink = sink;
        _logger = logger;
    }

    private readonly BasicChatRuntime _runtime;
    private readonly WorkspaceId _workspaceId;
    private readonly IChatRuntimeEventSink _sink;

    public void Register(BotId botId)
    {
        if (!RegisterCore(botId))
            throw new AmiraException(new(AmiraErrorCodes.BotWorkerAlreadyRegistered, ErrorCategory.Concurrency, "A worker is already registered for this Bot."));
    }

    /// <summary>Registers a worker when one is not already present.</summary>
    /// <returns><see langword="true"/> when a new worker was registered.</returns>
    public bool EnsureRegistered(BotId botId) => RegisterCore(botId);

    public async ValueTask<bool> UnregisterAsync(BotId botId)
    {
        Entry? entry;
        lock (_gate)
        {
            if (_stopping) throw Stopped();
            if (!_entries.Remove(botId, out entry)) return false;
        }

        try
        {
            await entry.Worker.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            // DisposeAsync waits until the run loop stops. Observe a previously
            // faulted run task without turning a successful archive into a
            // misleading lifecycle failure; the continuation registered below
            // has already logged the worker fault.
            if (entry.RunTask.IsFaulted) _ = entry.RunTask.Exception;
        }

        return true;
    }

    private bool RegisterCore(BotId botId)
    {
        lock (_gate)
        {
            if (_stopping) throw Stopped();
            if (_entries.ContainsKey(botId)) return false;
            IBotWorker worker = _runtime.CreateBotWorker(_workspaceId, botId);
            Task task = worker.RunAsync(_sink);
            _ = task.ContinueWith(static (completed, state) =>
            {
                if (!completed.IsFaulted) return;
                _ = completed.Exception;
                var (logger, id) = ((ILogger<BotWorkerRegistry> Logger, BotId Id))state!;
                logger.LogError("Bot worker failed: {Code} {BotId}", AmiraErrorCodes.BotWorkerFailed, id.Value);
            }, (_logger, botId), CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
            _entries.Add(botId, new Entry(worker, task));
            return true;
        }
    }

    public void Wake(BotId botId)
    {
        lock (_gate)
        {
            if (_stopping) throw Stopped();
            if (!_entries.TryGetValue(botId, out Entry? entry))
                throw new AmiraException(new(AmiraErrorCodes.BotWorkerNotRegistered, ErrorCategory.NotFound, "No worker is registered for this Bot."));
            if (entry.RunTask.IsFaulted)
                throw new AmiraException(new(AmiraErrorCodes.BotWorkerFailed, ErrorCategory.Infrastructure, "The Bot worker has failed.", true));
            if (entry.RunTask.IsCompleted)
                throw new AmiraException(new(AmiraErrorCodes.BotWorkerStopped, ErrorCategory.Concurrency, "The Bot worker has stopped."));
            entry.Worker.Wake();
        }
    }

    public async ValueTask DisposeAsync()
    {
        Entry[] entries;
        bool initiator;
        lock (_gate)
        {
            if (_stopping)
            {
                entries = [];
                initiator = false;
            }
            else
            {
                _stopping = true;
                entries = [.. _entries.Values];
                initiator = true;
            }
        }

        if (!initiator)
        {
            await _disposed.Task.ConfigureAwait(false);
            return;
        }

        Exception? failure = null;
        foreach (Entry entry in entries)
        {
            try { await entry.Worker.DisposeAsync().ConfigureAwait(false); }
            catch (Exception exception) { failure ??= exception; }
        }
        try { await Task.WhenAll(entries.Select(entry => entry.RunTask)).ConfigureAwait(false); }
        catch (Exception exception) { failure ??= exception; }
        if (failure is null)
        {
            _disposed.TrySetResult();
        }
        else _disposed.TrySetException(failure);
        await _disposed.Task.ConfigureAwait(false);
    }

    private static AmiraException Stopped() => new(new(
        AmiraErrorCodes.ClientHostStopped, ErrorCategory.Concurrency, "The client host is stopping or has stopped."));

    private sealed record Entry(IBotWorker Worker, Task RunTask);
}
