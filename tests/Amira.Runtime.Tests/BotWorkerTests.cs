using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;
using Microsoft.Extensions.Time.Testing;

namespace Amira.Runtime.Tests;

public sealed partial class RuntimeTests
{
    [Fact]
    public void Create_bot_worker_validates_product_input_and_configuration()
    {
        var fixture = new Fixture();

        AmiraException workspace = Assert.Throws<AmiraException>(() =>
            fixture.Runtime.CreateBotWorker(default, fixture.Bot.Id));
        AmiraException bot = Assert.Throws<AmiraException>(() =>
            fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, default));
        AmiraException configuration = Assert.Throws<AmiraException>(() =>
            fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id, new BotWorkerOptions
            {
                InitialIdleDelay = TimeSpan.FromSeconds(2),
                MaximumIdleDelay = TimeSpan.FromSeconds(1),
            }));

        Assert.Equal(AmiraErrorCodes.WorkspaceRequired, workspace.Code);
        Assert.Equal(ErrorCategory.Input, workspace.Category);
        Assert.Equal(AmiraErrorCodes.BotRequired, bot.Code);
        Assert.Equal(ErrorCategory.Input, bot.Category);
        Assert.Equal(AmiraErrorCodes.BotWorkerInvalidConfiguration, configuration.Code);
        Assert.Equal(ErrorCategory.Configuration, configuration.Category);
    }

    [Fact]
    public async Task Worker_wake_is_latched_before_run_coalesced_and_not_lost_after_empty_claim()
    {
        var fixture = new Fixture();
        var timeProvider = new FakeTimeProvider();
        IBotWorker worker = fixture.Runtime.CreateBotWorker(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            WorkerOptions(timeProvider));
        int emptyClaims = 0;
        fixture.Store.EmptyClaimObserved = () =>
        {
            if (Interlocked.Increment(ref emptyClaims) == 2)
            {
                worker.Wake();
            }
        };
        Parallel.For(0, 64, _ => worker.Wake());

        Task run = worker.RunAsync(new RecordingSink(), TestContext.Current.CancellationToken);
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount >= 3);

        Assert.Equal(3, fixture.Store.ClaimAttemptCount);
        Assert.Equal(0, fixture.Store.RecoveryCount);

        await worker.DisposeAsync();
        await run;
    }

    [Fact]
    public async Task Worker_idle_delay_backs_off_without_busy_polling_and_wake_resets_it()
    {
        var fixture = new Fixture();
        var manualTime = new FakeTimeProvider();
        var timeProvider = new RecordingTimeProvider(manualTime);
        IBotWorker worker = fixture.Runtime.CreateBotWorker(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            WorkerOptions(timeProvider));

        Task run = worker.RunAsync(new RecordingSink(), TestContext.Current.CancellationToken);
        Assert.Equal(1, fixture.Store.ClaimAttemptCount);
        await WaitUntilAsync(() => timeProvider.ScheduledDelays.Count == 1);

        manualTime.Advance(TimeSpan.FromMilliseconds(99));
        Assert.Equal(1, fixture.Store.ClaimAttemptCount);
        manualTime.Advance(TimeSpan.FromMilliseconds(1));
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount == 2 && timeProvider.ScheduledDelays.Count == 2);
        manualTime.Advance(TimeSpan.FromMilliseconds(199));
        Assert.Equal(2, fixture.Store.ClaimAttemptCount);
        manualTime.Advance(TimeSpan.FromMilliseconds(1));
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount == 3 && timeProvider.ScheduledDelays.Count == 3);
        manualTime.Advance(TimeSpan.FromMilliseconds(400));
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount == 4 && timeProvider.ScheduledDelays.Count == 4);
        Assert.Equal(
            [100, 200, 400, 400],
            timeProvider.ScheduledDelays.Select(static delay => (int)delay.TotalMilliseconds));

        worker.Wake();
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount == 5 && timeProvider.ScheduledDelays.Count == 5);
        Assert.Equal(TimeSpan.FromMilliseconds(100), timeProvider.ScheduledDelays[^1]);
        manualTime.Advance(TimeSpan.FromMilliseconds(99));
        Assert.Equal(5, fixture.Store.ClaimAttemptCount);
        manualTime.Advance(TimeSpan.FromMilliseconds(1));
        await WaitUntilAsync(() => fixture.Store.ClaimAttemptCount == 6);

        await worker.DisposeAsync();
        await run;
    }

    [Fact]
    public async Task Worker_awaits_sink_and_preserves_runtime_event_order()
    {
        var logger = new CapturingLogger();
        var fixture = new Fixture(new FakeProvider(
            new ModelStreamEvent.Started(),
            new ModelStreamEvent.TextDelta("one "),
            new ModelStreamEvent.TextDelta("two"),
            new ModelStreamEvent.Usage(new ProviderUsage(2, 3)),
            new ModelStreamEvent.Completed()),
            logger: logger);
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "hello",
            TestContext.Current.CancellationToken);
        var sink = new FirstEventBlockingSink();
        IBotWorker worker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);

        Task run = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        ChatRuntimeEvent first = await sink.FirstEvent.WaitAsync(
            TimeSpan.FromSeconds(5),
            TestContext.Current.CancellationToken);

        Assert.IsType<ChatRuntimeEvent.Started>(first);
        Assert.Equal(BotTurnStatus.Running, fixture.Store.GetTurn(queued.Turn.Id).Status);
        Assert.Equal(0, fixture.Store.CompletedCount);

        sink.Release();
        await sink.Terminal.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Collection(
            sink.Events,
            item => Assert.IsType<ChatRuntimeEvent.Started>(item),
            item => Assert.Equal("one ", Assert.IsType<ChatRuntimeEvent.TextDelta>(item).Text),
            item => Assert.Equal("two", Assert.IsType<ChatRuntimeEvent.TextDelta>(item).Text),
            item => Assert.Equal(3, Assert.IsType<ChatRuntimeEvent.UsageReported>(item).Value.OutputTokens),
            item => Assert.Equal("one two", Assert.IsType<ChatRuntimeEvent.Completed>(item).Text));
        Assert.Single(logger.Entries, entry => entry.EventId.Id == (int)AmiraLogEvent.TurnClaimed);

        await worker.DisposeAsync();
        await run;
    }

    [Fact]
    public async Task Workers_keep_same_bot_serial_while_different_workers_compete()
    {
        var provider = new GatedProvider();
        var fixture = new Fixture(provider);
        QueuedMessageResult first = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "first", TestContext.Current.CancellationToken);
        QueuedMessageResult second = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "second", TestContext.Current.CancellationToken);
        var sink = new RecordingSink(2);
        IBotWorker workerA = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);
        IBotWorker workerB = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);

        Task runA = workerA.RunAsync(sink, TestContext.Current.CancellationToken);
        Task runB = workerB.RunAsync(sink, TestContext.Current.CancellationToken);
        await WaitUntilAsync(() => provider.StartedCount == 1);
        Assert.Equal(1, provider.MaximumActive);

        provider.Release();
        await WaitUntilAsync(() => provider.StartedCount == 2);
        Assert.Equal(1, provider.MaximumActive);
        provider.Release();
        await sink.Terminal.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Equal(BotTurnStatus.Completed, fixture.Store.GetTurn(first.Turn.Id).Status);
        Assert.Equal(BotTurnStatus.Completed, fixture.Store.GetTurn(second.Turn.Id).Status);
        Assert.Equal(0, fixture.Store.RecoveryCount);

        await Task.WhenAll(workerA.DisposeAsync().AsTask(), workerB.DisposeAsync().AsTask());
        await Task.WhenAll(runA, runB);
    }

    [Fact]
    public async Task Workers_for_different_bots_execute_in_parallel()
    {
        var provider = new GatedProvider();
        var fixture = new Fixture(provider);
        Bot otherBot = fixture.AddBot("parallel");
        await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "primary", TestContext.Current.CancellationToken);
        await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, otherBot.Id, "other", TestContext.Current.CancellationToken);
        var sink = new RecordingSink(2);
        IBotWorker primaryWorker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);
        IBotWorker otherWorker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, otherBot.Id);

        Task primaryRun = primaryWorker.RunAsync(sink, TestContext.Current.CancellationToken);
        Task otherRun = otherWorker.RunAsync(sink, TestContext.Current.CancellationToken);
        await WaitUntilAsync(() => provider.MaximumActive == 2);

        provider.Release(2);
        await sink.Terminal.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Equal(2, fixture.Store.CompletedCount);

        await Task.WhenAll(primaryWorker.DisposeAsync().AsTask(), otherWorker.DisposeAsync().AsTask());
        await Task.WhenAll(primaryRun, otherRun);
    }

    [Fact]
    public async Task Worker_is_one_shot_and_idle_dispose_is_idempotent()
    {
        var fixture = new Fixture();
        var timeProvider = new FakeTimeProvider();
        IBotWorker worker = fixture.Runtime.CreateBotWorker(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            WorkerOptions(timeProvider));
        var sink = new RecordingSink();

        ArgumentNullException nullSink = Assert.Throws<ArgumentNullException>(() =>
        {
            _ = worker.RunAsync(null!, TestContext.Current.CancellationToken);
        });
        Task run = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        AmiraException running = Assert.Throws<AmiraException>(() =>
        {
            _ = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        });
        await Task.WhenAll(worker.DisposeAsync().AsTask(), worker.DisposeAsync().AsTask());
        await run;
        AmiraException disposedRun = Assert.Throws<AmiraException>(() =>
        {
            _ = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        });
        AmiraException disposedWake = Assert.Throws<AmiraException>(worker.Wake);

        Assert.Equal(AmiraErrorCodes.BotWorkerNotRunnable, running.Code);
        Assert.Equal(ErrorCategory.Concurrency, running.Category);
        Assert.Equal(AmiraErrorCodes.BotWorkerNotRunnable, disposedRun.Code);
        Assert.Equal(AmiraErrorCodes.BotWorkerNotRunnable, disposedWake.Code);
        Assert.Equal("sink", nullSink.ParamName);
    }

    [Fact]
    public async Task Disposing_during_provider_stream_durably_cancels_current_and_preserves_queued_turn()
    {
        var provider = new GatedProvider();
        var fixture = new Fixture(provider);
        QueuedMessageResult current = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "current", TestContext.Current.CancellationToken);
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "queued", TestContext.Current.CancellationToken);
        var sink = new RecordingSink();
        IBotWorker worker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);

        Task run = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        await WaitUntilAsync(() => sink.Events.Any(item => item is ChatRuntimeEvent.TextDelta));

        await worker.DisposeAsync();
        await run;

        Assert.Equal(BotTurnStatus.Cancelled, fixture.Store.GetTurn(current.Turn.Id).Status);
        Assert.Equal(BotTurnStatus.Queued, fixture.Store.GetTurn(queued.Turn.Id).Status);
        Assert.Equal(1, fixture.Store.StopCount);
        Assert.Equal(1, fixture.Store.CancelledCount);
        Assert.Equal(0, fixture.Store.RecoveryCount);
    }

    [Fact]
    public async Task Sink_failure_before_terminal_cancels_turn_and_bubbles_original_exception()
    {
        var fixture = new Fixture();
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        var sink = new ThrowingSink(static item => item is ChatRuntimeEvent.TextDelta);
        IBotWorker worker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);

        Task run = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() => run);

        Assert.Equal(ThrowingSink.FailureMessage, exception.Message);
        Assert.Equal(BotTurnStatus.Cancelled, fixture.Store.GetTurn(queued.Turn.Id).Status);
        Assert.Equal(1, fixture.Store.CancelledCount);
        Assert.Equal(1, fixture.Store.StopCount);

        AmiraException stoppedRun = Assert.Throws<AmiraException>(() =>
        {
            _ = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        });
        AmiraException stoppedWake = Assert.Throws<AmiraException>(worker.Wake);
        Assert.Equal(AmiraErrorCodes.BotWorkerNotRunnable, stoppedRun.Code);
        Assert.Equal(AmiraErrorCodes.BotWorkerNotRunnable, stoppedWake.Code);

        await worker.DisposeAsync();
    }

    [Fact]
    public async Task Sink_failure_on_terminal_does_not_roll_back_completed_turn()
    {
        var fixture = new Fixture();
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        var sink = new ThrowingSink(static item => item is ChatRuntimeEvent.Completed);
        IBotWorker worker = fixture.Runtime.CreateBotWorker(fixture.WorkspaceId, fixture.Bot.Id);

        Task run = worker.RunAsync(sink, TestContext.Current.CancellationToken);
        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() => run);

        Assert.Equal(ThrowingSink.FailureMessage, exception.Message);
        Assert.Equal(BotTurnStatus.Completed, fixture.Store.GetTurn(queued.Turn.Id).Status);
        Assert.Equal(1, fixture.Store.CompletedCount);
        Assert.Equal(0, fixture.Store.CancelledCount);
        Assert.Equal(0, fixture.Store.StopCount);

        await worker.DisposeAsync();
    }

    private static BotWorkerOptions WorkerOptions(TimeProvider timeProvider) => new()
    {
        InitialIdleDelay = TimeSpan.FromMilliseconds(100),
        MaximumIdleDelay = TimeSpan.FromMilliseconds(400),
        TimeProvider = timeProvider,
    };

    private static async Task WaitUntilAsync(Func<bool> condition)
    {
        DateTimeOffset timeout = DateTimeOffset.UtcNow.AddSeconds(5);
        while (!condition() && DateTimeOffset.UtcNow < timeout)
        {
            await Task.Delay(10, TestContext.Current.CancellationToken);
        }

        Assert.True(condition(), "The asynchronous condition was not reached before the timeout.");
    }

    private sealed class RecordingSink(int terminalTarget = 1) : IChatRuntimeEventSink
    {
        private readonly object _gate = new();
        private readonly List<ChatRuntimeEvent> _events = [];
        private readonly TaskCompletionSource _terminal = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private int _terminalCount;

        public IReadOnlyList<ChatRuntimeEvent> Events
        {
            get
            {
                lock (_gate)
                {
                    return [.. _events];
                }
            }
        }

        public Task Terminal => terminalTarget > 0 ? _terminal.Task : Task.CompletedTask;

        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
        {
            lock (_gate)
            {
                _events.Add(runtimeEvent);
                if (runtimeEvent is (ChatRuntimeEvent.Completed or ChatRuntimeEvent.Failed or ChatRuntimeEvent.Cancelled)
                    && ++_terminalCount == terminalTarget)
                {
                    _terminal.TrySetResult();
                }
            }

            return ValueTask.CompletedTask;
        }
    }

    private sealed class FirstEventBlockingSink : IChatRuntimeEventSink
    {
        private readonly TaskCompletionSource<ChatRuntimeEvent> _firstEvent = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _terminal = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly List<ChatRuntimeEvent> _events = [];

        public Task<ChatRuntimeEvent> FirstEvent => _firstEvent.Task;
        public Task Terminal => _terminal.Task;
        public IReadOnlyList<ChatRuntimeEvent> Events => _events;

        public async ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
        {
            if (_firstEvent.TrySetResult(runtimeEvent))
            {
                await _release.Task.WaitAsync(cancellationToken);
            }

            _events.Add(runtimeEvent);
            if (runtimeEvent is ChatRuntimeEvent.Completed or ChatRuntimeEvent.Failed or ChatRuntimeEvent.Cancelled)
            {
                _terminal.TrySetResult();
            }
        }

        public void Release() => _release.TrySetResult();
    }

    private sealed class ThrowingSink(Func<ChatRuntimeEvent, bool> shouldThrow) : IChatRuntimeEventSink
    {
        public const string FailureMessage = "sink failed";

        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
        {
            if (shouldThrow(runtimeEvent))
            {
                throw new InvalidOperationException(FailureMessage);
            }

            return ValueTask.CompletedTask;
        }
    }

    private sealed class GatedProvider : IModelProvider
    {
        private readonly SemaphoreSlim _release = new(0);
        private int _active;
        private int _maximumActive;
        private int _startedCount;

        public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;
        public int MaximumActive => Volatile.Read(ref _maximumActive);
        public int StartedCount => Volatile.Read(ref _startedCount);

        public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(
            ProviderConnection connection,
            ModelRequest request,
            [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            int active = Interlocked.Increment(ref _active);
            UpdateMaximum(active);
            Interlocked.Increment(ref _startedCount);
            try
            {
                yield return new ModelStreamEvent.Started();
                yield return new ModelStreamEvent.TextDelta("reply");
                await _release.WaitAsync(cancellationToken);
                yield return new ModelStreamEvent.Completed();
            }
            finally
            {
                Interlocked.Decrement(ref _active);
            }
        }

        public void Release(int count = 1) => _release.Release(count);

        private void UpdateMaximum(int active)
        {
            int observed = Volatile.Read(ref _maximumActive);
            while (active > observed)
            {
                int prior = Interlocked.CompareExchange(ref _maximumActive, active, observed);
                if (prior == observed)
                {
                    return;
                }

                observed = prior;
            }
        }
    }

    private sealed class RecordingTimeProvider(FakeTimeProvider inner) : TimeProvider
    {
        private readonly object _gate = new();
        private readonly List<TimeSpan> _scheduledDelays = [];

        public IReadOnlyList<TimeSpan> ScheduledDelays
        {
            get
            {
                lock (_gate)
                {
                    return [.. _scheduledDelays];
                }
            }
        }

        public override TimeZoneInfo LocalTimeZone => inner.LocalTimeZone;
        public override long TimestampFrequency => inner.TimestampFrequency;
        public override DateTimeOffset GetUtcNow() => inner.GetUtcNow();
        public override long GetTimestamp() => inner.GetTimestamp();

        public override ITimer CreateTimer(
            TimerCallback callback,
            object? state,
            TimeSpan dueTime,
            TimeSpan period)
        {
            lock (_gate)
            {
                _scheduledDelays.Add(dueTime);
            }

            return inner.CreateTimer(callback, state, dueTime, period);
        }
    }
}
