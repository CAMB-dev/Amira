using System.Threading.Channels;
using Amira.Runtime;
using Microsoft.UI.Dispatching;

namespace Amira.Client.WinUI;

public sealed class WinUiChatRuntimeEventSink(DispatcherQueue dispatcherQueue) : IChatRuntimeEventSink
{
    private readonly Channel<ChatRuntimeEvent> _events = Channel.CreateBounded<ChatRuntimeEvent>(new BoundedChannelOptions(1024) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = false });
    private readonly DispatcherQueue _dispatcherQueue = dispatcherQueue ?? throw new ArgumentNullException(nameof(dispatcherQueue));
    private Func<ChatRuntimeEvent, Task>? _handler;
    private Task? _pump;
    public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(runtimeEvent);
        return _events.Writer.WriteAsync(runtimeEvent, cancellationToken);
    }
    public void Attach(Func<ChatRuntimeEvent, Task> handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        if (Interlocked.CompareExchange(ref _handler, handler, null) is not null) throw new InvalidOperationException("A UI handler is already attached.");
        _pump = PumpAsync();
    }
    public async Task CompleteAndDrainAsync()
    {
        _events.Writer.TryComplete();
        if (_pump is not null) await _pump.ConfigureAwait(false);
    }
    private async Task PumpAsync()
    {
        await foreach (ChatRuntimeEvent runtimeEvent in _events.Reader.ReadAllAsync())
        {
            Func<ChatRuntimeEvent, Task>? handler = _handler;
            if (handler is null) continue;
            TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
            if (!_dispatcherQueue.TryEnqueue(() => _ = DispatchAsync(handler, runtimeEvent, completion))) throw new InvalidOperationException("The UI dispatcher is unavailable.");
            await completion.Task.ConfigureAwait(false);
        }
    }
    private static async Task DispatchAsync(Func<ChatRuntimeEvent, Task> handler, ChatRuntimeEvent runtimeEvent, TaskCompletionSource completion)
    {
        try { await handler(runtimeEvent); completion.SetResult(); }
        catch (Exception exception) { completion.SetException(exception); }
    }
}
