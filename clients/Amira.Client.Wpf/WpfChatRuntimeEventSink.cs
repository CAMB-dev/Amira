using System.Threading.Channels;
using System.Windows.Threading;
using Amira.Runtime;

namespace Amira.Client.Wpf;

public sealed class WpfChatRuntimeEventSink : IChatRuntimeEventSink
{
    private readonly Channel<ChatRuntimeEvent> _events = Channel.CreateBounded<ChatRuntimeEvent>(new BoundedChannelOptions(1024) { FullMode = BoundedChannelFullMode.Wait, SingleReader = true, SingleWriter = false });
    private readonly Dispatcher _dispatcher;
    private Func<ChatRuntimeEvent, Task>? _handler;
    private Task? _pump;

    public WpfChatRuntimeEventSink(Dispatcher dispatcher) => _dispatcher = dispatcher ?? throw new ArgumentNullException(nameof(dispatcher));
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
            if (handler is not null)
            {
                await _dispatcher.InvokeAsync(() => handler(runtimeEvent)).Task.Unwrap().ConfigureAwait(false);
            }
        }
    }
}
