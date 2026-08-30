using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Runtime.Tests;

public sealed partial class RuntimeTests
{
    [Fact]
    public async Task Context_keeps_latest_and_crops_old_committed_messages_exactly()
    {
        var fixture = new Fixture();
        fixture.Store.Timeline.AddRange([
            fixture.Message(MessageAuthor.Human, "old"),
            fixture.Message(MessageAuthor.Bot, "middle"),
            fixture.Message(MessageAuthor.Human, " latest ")]);
        var turn = fixture.QueuedTurn(fixture.Store.Timeline[^1].Id);
        fixture.Store.Timeline.Add(fixture.Message(MessageAuthor.Human, "newer message"));
        var result = await new ContextBuilder(fixture.Store).BuildAsync(fixture.WorkspaceId, fixture.Bot, turn, 14, TestContext.Current.CancellationToken);

        Assert.Equal(["middle", " latest "], result.Request.Messages.Select(x => x.Content));
        Assert.Equal("instructions", result.Request.SystemInstruction);
        Assert.Equal(2, result.Diagnostics.IncludedMessageCount);
        Assert.Equal(1, result.Diagnostics.DroppedMessageCount);
        Assert.Equal(3, result.Diagnostics.DroppedCharacters);
    }

    [Fact]
    public async Task Context_keeps_an_oversized_trigger_whole_and_ignores_messages_after_it()
    {
        var fixture = new Fixture();
        ChatMessage trigger = fixture.Message(MessageAuthor.Human, "trigger-too-large");
        fixture.Store.Timeline.Add(trigger);
        fixture.Store.Timeline.Add(fixture.Message(MessageAuthor.Human, "sent-after-claim"));
        var result = await new ContextBuilder(fixture.Store).BuildAsync(
            fixture.WorkspaceId, fixture.Bot, fixture.QueuedTurn(trigger.Id), 3, TestContext.Current.CancellationToken);

        Assert.Equal(["trigger-too-large"], result.Request.Messages.Select(x => x.Content));
        Assert.Equal(1, result.Diagnostics.IncludedMessageCount);
        Assert.Equal(0, result.Diagnostics.DroppedMessageCount);
    }

    [Fact]
    public async Task Successful_stream_emits_preview_and_commits_only_after_completed()
    {
        var fixture = new Fixture(new FakeProvider(
            new ModelStreamEvent.Started(), new ModelStreamEvent.TextDelta("a "),
            new ModelStreamEvent.TextDelta("b"), new ModelStreamEvent.Usage(new ProviderUsage(2, 3)), new ModelStreamEvent.Completed()));
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));

        Assert.Collection(events,
            x => Assert.IsType<ChatRuntimeEvent.Started>(x),
            x => Assert.Equal("a ", Assert.IsType<ChatRuntimeEvent.TextDelta>(x).Text),
            x => Assert.Equal("b", Assert.IsType<ChatRuntimeEvent.TextDelta>(x).Text),
            x => Assert.Equal(3, Assert.IsType<ChatRuntimeEvent.UsageReported>(x).Value.OutputTokens),
            x => Assert.Equal("a b", Assert.IsType<ChatRuntimeEvent.Completed>(x).Text));
        Assert.Equal(1, fixture.Store.CompletedCount);
        Assert.Empty(fixture.Store.Failures);
        Assert.Contains(fixture.Store.Timeline, x => x.Author == MessageAuthor.Bot && x.Revision.Content == "a b");
        Assert.Equal(queued.Message.Id, fixture.Store.Timeline[0].Id);
    }

    [Fact]
    public async Task Provider_failure_preserves_the_typed_error()
    {
        var fixture = new Fixture(new FakeProvider(new AmiraException(new AmiraError("provider_bad", ErrorCategory.Provider, "The provider request failed.\n", true))));
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));

        var failed = Assert.IsType<ChatRuntimeEvent.Failed>(Assert.Single(events, x => x is ChatRuntimeEvent.Failed));
        Assert.Equal("provider_bad", failed.Failure.Code);
        Assert.Equal("The provider request failed.\n", failed.Failure.Message);
        Assert.Equal("provider_bad", Assert.Single(fixture.Store.Failures).Code);
    }

    [Fact]
    public async Task Invalid_order_and_empty_reply_fail_without_archive_assistant()
    {
        var fixture = new Fixture(new FakeProvider(new ModelStreamEvent.TextDelta("before-start")));
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));
        Assert.Equal("invalid_stream", Assert.IsType<ChatRuntimeEvent.Failed>(events[^1]).Failure.Code);
        Assert.Equal(0, fixture.Store.CompletedCount);
        Assert.DoesNotContain(fixture.Store.Timeline, x => x.Author == MessageAuthor.Bot);
    }

    [Fact]
    public async Task Whitespace_only_reply_is_a_stable_empty_response_failure()
    {
        var fixture = new Fixture(new FakeProvider(new ModelStreamEvent.Started(), new ModelStreamEvent.TextDelta(" \n "), new ModelStreamEvent.Completed()));
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));

        Assert.Equal("empty_response", Assert.IsType<ChatRuntimeEvent.Failed>(events[^1]).Failure.Code);
        Assert.Equal(0, fixture.Store.CompletedCount);
    }

    [Fact]
    public async Task Unexpected_programming_exception_bubbles_without_becoming_a_runtime_failure()
    {
        var fixture = new Fixture(new FakeProvider(new InvalidOperationException("credential=super-secret provider payload")));
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken)));

        Assert.Contains("super-secret", exception.Message);
        Assert.Empty(fixture.Store.Failures);
        Assert.Equal(1, fixture.Store.CancelledCount);
    }

    [Fact]
    public async Task Caller_stopping_after_a_delta_disposes_provider_then_durably_cancels_claim()
    {
        var fixture = new Fixture(new BlockingProvider());
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        await using IAsyncEnumerator<ChatRuntimeEvent> enumerator = fixture.Runtime
            .ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken)
            .GetAsyncEnumerator(TestContext.Current.CancellationToken);
        Assert.True(await enumerator.MoveNextAsync());
        Assert.IsType<ChatRuntimeEvent.Started>(enumerator.Current);
        Assert.True(await enumerator.MoveNextAsync());
        Assert.IsType<ChatRuntimeEvent.TextDelta>(enumerator.Current);

        await enumerator.DisposeAsync();

        Assert.Equal(1, fixture.Store.StopCount);
        Assert.Equal(1, fixture.Store.CancelledCount);
    }

    [Fact]
    public async Task Provider_dispose_failure_cleans_claim_then_bubbles_original_exception()
    {
        var fixture = new Fixture(new DisposeThrowingProvider());
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);

        InvalidOperationException exception = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken)));

        Assert.Equal("dispose failed", exception.Message);
        Assert.Equal(1, fixture.Store.StopCount);
        Assert.Equal(1, fixture.Store.CancelledCount);
        Assert.Empty(fixture.Store.Failures);
    }

    [Fact]
    public async Task Disabled_connection_is_checked_after_human_message_and_turn_are_committed()
    {
        var fixture = new Fixture(connectionEnabled: false);

        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "must persist",
            TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(fixture.Runtime.ExecuteNextAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            TestContext.Current.CancellationToken));

        Assert.Equal("connection_disabled", Assert.IsType<ChatRuntimeEvent.Failed>(Assert.Single(events)).Failure.Code);
        Assert.Equal(queued.Message.Id, Assert.Single(fixture.Store.Timeline).Id);
        Assert.Equal("must persist", fixture.Store.Timeline[0].Revision.Content);
        Assert.Equal(BotTurnStatus.Failed, fixture.Store.GetTurn(queued.Turn.Id).Status);
    }

    [Fact]
    public async Task Missing_provider_registration_fails_only_after_message_first_commit()
    {
        var fixture = new Fixture();
        var runtime = new BasicChatRuntime(fixture.Store, fixture.Store, new ProviderRegistry());

        QueuedMessageResult queued = await runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "message first",
            TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await Collect(runtime.ExecuteNextAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            TestContext.Current.CancellationToken));

        Assert.Equal("provider_unavailable", Assert.IsType<ChatRuntimeEvent.Failed>(Assert.Single(events)).Failure.Code);
        Assert.Equal(queued.Message.Id, Assert.Single(fixture.Store.Timeline).Id);
    }

    [Fact]
    public async Task Execute_next_claims_only_the_requested_bots_turn()
    {
        var fixture = new Fixture();
        Bot otherBot = fixture.AddBot("other");
        QueuedMessageResult otherQueued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            otherBot.Id,
            "other first",
            TestContext.Current.CancellationToken);
        QueuedMessageResult requested = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "requested second",
            TestContext.Current.CancellationToken);

        List<ChatRuntimeEvent> requestedEvents = await Collect(fixture.Runtime.ExecuteNextAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            TestContext.Current.CancellationToken));

        Assert.All(requestedEvents, item =>
        {
            Assert.Equal(requested.Turn.Id, item.TurnId);
            Assert.Equal(fixture.Bot.Id, item.BotId);
        });
        Assert.Equal(BotTurnStatus.Completed, fixture.Store.GetTurn(requested.Turn.Id).Status);
        Assert.Equal(BotTurnStatus.Queued, fixture.Store.GetTurn(otherQueued.Turn.Id).Status);
        Assert.Single(fixture.Store.TimelineFor(otherBot.DirectChatId));

        List<ChatRuntimeEvent> otherEvents = await Collect(fixture.Runtime.ExecuteNextAsync(
            fixture.WorkspaceId,
            otherBot.Id,
            TestContext.Current.CancellationToken));

        Assert.All(otherEvents, item => Assert.Equal(otherQueued.Turn.Id, item.TurnId));
        Assert.Equal(BotTurnStatus.Completed, fixture.Store.GetTurn(otherQueued.Turn.Id).Status);
    }

    [Fact]
    public async Task Stop_durably_requests_stop_before_cancelling_active_provider()
    {
        var provider = new BlockingProvider();
        var fixture = new Fixture(provider);
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        Task<List<ChatRuntimeEvent>> execution = Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));
        await provider.Started.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        StopResult stop = await fixture.Runtime.StopAsync(provider.TurnId, TestContext.Current.CancellationToken);
        List<ChatRuntimeEvent> events = await execution.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.True(stop.DurableStopRequested);
        Assert.True(stop.CancellationSignaled);
        Assert.Contains(events, x => x is ChatRuntimeEvent.Cancelled);
        Assert.Equal(1, fixture.Store.StopCount);
        Assert.Equal(0, fixture.Store.CompletedCount);
    }

    [Fact]
    public async Task External_cancellation_also_uses_uncancelled_durable_stop()
    {
        var provider = new BlockingProvider();
        var fixture = new Fixture(provider);
        await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        using var cancellation = new CancellationTokenSource();
        Task<List<ChatRuntimeEvent>> execution = Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, cancellation.Token));
        await provider.Started.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        cancellation.Cancel();
        List<ChatRuntimeEvent> events = await execution.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Contains(events, x => x is ChatRuntimeEvent.Cancelled);
        Assert.Equal(1, fixture.Store.StopCount);
    }

    [Fact]
    public async Task Retry_is_delegated_and_does_not_insert_a_human_message()
    {
        var fixture = new Fixture(new FakeProvider(new ModelStreamEvent.Started(), new ModelStreamEvent.TextDelta("ok")));
        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(fixture.WorkspaceId, fixture.Bot.Id, "hello", TestContext.Current.CancellationToken);
        await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));
        BotTurn retry = await fixture.Runtime.RetryAsync(queued.Turn.Id, TestContext.Current.CancellationToken);

        Assert.Equal(2, retry.Attempt);
        Assert.Single(fixture.Store.Retried);
        Assert.Single(fixture.Store.Timeline, x => x.Author == MessageAuthor.Human);
    }

    private static async Task<List<ChatRuntimeEvent>> Collect(IAsyncEnumerable<ChatRuntimeEvent> source)
    {
        var result = new List<ChatRuntimeEvent>();
        await foreach (ChatRuntimeEvent item in source) result.Add(item);
        return result;
    }

    private sealed class Fixture
    {
        public Fixture(
            IModelProvider? provider = null,
            bool connectionEnabled = true,
            Microsoft.Extensions.Logging.ILogger? logger = null,
            System.Diagnostics.Metrics.IMeterFactory? meterFactory = null,
            string credentialReference = "cred",
            IReadOnlyDictionary<string, string>? extraHeaders = null)
        {
            WorkspaceId = WorkspaceId.Create("workspace");
            Connection = ProviderConnection.Rehydrate(
                ProviderConnectionId.Create("connection"),
                ProviderProtocol.OpenAIChatCompatible,
                "test",
                new Uri("https://example.test"),
                CredentialReference.Create(credentialReference),
                "model",
                extraHeaders ?? new Dictionary<string, string>(),
                connectionEnabled);
            Bot = MakeBot("primary", Connection.Id);
            Store = new InMemoryAmiraStore(Bot, Connection);
            Provider = provider ?? new FakeProvider(new ModelStreamEvent.Started(), new ModelStreamEvent.TextDelta("reply"), new ModelStreamEvent.Completed());
            Runtime = new BasicChatRuntime(Store, Store, new ProviderRegistry([Provider]), 100, logger, meterFactory);
        }
        public WorkspaceId WorkspaceId { get; }
        public Bot Bot { get; }
        public ProviderConnection Connection { get; }
        public InMemoryAmiraStore Store { get; }
        public IModelProvider Provider { get; }
        public BasicChatRuntime Runtime { get; }

        public BotTurn QueuedTurn(MessageId? trigger = null) => BotTurn.Queue(Bot.Id, Bot.DirectChatId, [trigger ?? MessageId.New()], Bot.ModelProfile.Snapshot(Provider.Protocol));
        public ChatMessage Message(MessageAuthor author, string content) => Store.CreateMessage(Bot.DirectChatId, author, content);

        public Bot AddBot(string name)
        {
            Bot bot = MakeBot(name, Connection.Id);
            Store.AddBot(bot);
            return bot;
        }

        private static Bot MakeBot(string id, ProviderConnectionId connectionId)
        {
            DateTimeOffset createdAt = DateTimeOffset.UnixEpoch;
            BotProfile profile = BotProfile.Rehydrate(
                BotProfileId.Create($"{id}-profile"),
                id,
                null,
                "instructions",
                createdAt,
                createdAt);
            ModelProfile modelProfile = ModelProfile.Rehydrate(
                ModelProfileId.Create($"{id}-model-profile"),
                connectionId,
                "model",
                new GenerationOptions(),
                new Dictionary<string, string>());
            return Bot.Rehydrate(
                BotId.Create($"{id}-bot"),
                profile,
                modelProfile,
                DirectChatId.Create($"{id}-chat"),
                createdAt,
                BotLifecycleState.Active);
        }
    }

    private sealed class FakeProvider(params object[] behavior) : IModelProvider
    {
        public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;
        public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(ProviderConnection connection, ModelRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            await Task.Yield();
            foreach (object item in behavior)
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (item is Exception exception) throw exception;
                yield return (ModelStreamEvent)item;
            }
        }
    }

    private sealed class BlockingProvider : IModelProvider
    {
        public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;
        public BotTurnId TurnId { get; private set; }
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public async IAsyncEnumerable<ModelStreamEvent> StreamAsync(ProviderConnection connection, ModelRequest request, [EnumeratorCancellation] CancellationToken cancellationToken = default)
        {
            TurnId = request.BotTurnId;
            yield return new ModelStreamEvent.Started();
            Started.SetResult();
            yield return new ModelStreamEvent.TextDelta("partial");
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            yield return new ModelStreamEvent.Completed();
        }
    }

    private sealed class DisposeThrowingProvider : IModelProvider
    {
        public ProviderProtocol Protocol => ProviderProtocol.OpenAIChatCompatible;
        public IAsyncEnumerable<ModelStreamEvent> StreamAsync(ProviderConnection connection, ModelRequest request, CancellationToken cancellationToken = default) =>
            new DisposeThrowingEnumerable();

        private sealed class DisposeThrowingEnumerable : IAsyncEnumerable<ModelStreamEvent>, IAsyncEnumerator<ModelStreamEvent>
        {
            private int _position;
            public ModelStreamEvent Current { get; private set; } = new ModelStreamEvent.Started();
            public IAsyncEnumerator<ModelStreamEvent> GetAsyncEnumerator(CancellationToken cancellationToken = default) => this;
            public ValueTask<bool> MoveNextAsync()
            {
                if (_position++ == 0)
                {
                    Current = new ModelStreamEvent.Started();
                    return ValueTask.FromResult(true);
                }

                return ValueTask.FromResult(false);
            }
            public ValueTask DisposeAsync() => ValueTask.FromException(new InvalidOperationException("dispose failed"));
        }
    }

}
