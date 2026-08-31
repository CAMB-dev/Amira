using Amira.Client.Composition.Windows;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Client.WinUI.Tests;

public sealed class ActivityViewModelTests
{
    [Fact]
    public async Task Stateful_events_refresh_one_durable_turn_while_text_and_usage_stay_lightweight()
    {
        Bot bot = CreateBot("Bot");
        DateTimeOffset queuedAt = DateTimeOffset.UtcNow;
        TurnView queued = CreateTurn(bot, BotTurnStatus.Queued, queuedAt);
        await using var session = new ActivityClientSession([bot], [queued]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();

        DateTimeOffset startedAt = queuedAt.AddMilliseconds(20);
        session.SetDurable(queued with { Status = BotTurnStatus.Running, StartedAt = startedAt });
        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model));

        Assert.Equal(1, session.GetTurnCalls);
        Assert.Equal(BotTurnStatus.Running, viewModel.SelectedActivity?.Status);
        Assert.Equal(startedAt, viewModel.SelectedActivity?.StartedAt);

        DateTimeOffset firstTokenAt = startedAt.AddMilliseconds(30);
        session.SetDurable(queued with
        {
            Status = BotTurnStatus.Running,
            StartedAt = startedAt,
            FirstTokenAt = firstTokenAt,
        });
        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.TextDelta(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model, "first"));
        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.TextDelta(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model, " second"));

        Assert.Equal(2, session.GetTurnCalls);
        Assert.Equal(firstTokenAt, viewModel.SelectedActivity?.FirstTokenAt);

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.UsageReported(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model, new ProviderUsage(12, 3)));

        Assert.Equal(2, session.GetTurnCalls);
        Assert.Equal(12, viewModel.SelectedActivity?.Usage?.InputTokens);
        Assert.Equal(3, viewModel.SelectedActivity?.Usage?.OutputTokens);

        DateTimeOffset finishedAt = firstTokenAt.AddMilliseconds(40);
        session.SetDurable(queued with
        {
            Status = BotTurnStatus.Completed,
            StartedAt = startedAt,
            FirstTokenAt = firstTokenAt,
            FinishedAt = finishedAt,
            Usage = new TurnUsage(14, 4),
        });
        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Completed(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model, "done", new ProviderUsage(99, 99)));

        Assert.Equal(3, session.GetTurnCalls);
        Assert.Equal(1, session.QueryTurnCalls);
        Assert.Equal(BotTurnStatus.Completed, viewModel.SelectedActivity?.Status);
        Assert.Equal(14, viewModel.SelectedActivity?.Usage?.InputTokens);
        Assert.Equal(4, viewModel.SelectedActivity?.Usage?.OutputTokens);
    }

    [Fact]
    public async Task A_persisted_first_token_timestamp_prevents_later_delta_store_reads()
    {
        Bot bot = CreateBot("Bot");
        DateTimeOffset queuedAt = DateTimeOffset.UtcNow;
        TurnView running = CreateTurn(bot, BotTurnStatus.Running, queuedAt) with
        {
            FirstTokenAt = queuedAt.AddMilliseconds(25),
        };
        await using var session = new ActivityClientSession([bot], [running]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.TextDelta(
            running.TurnId, bot.Id, running.Protocol, running.Model, "later"));

        Assert.Equal(0, session.GetTurnCalls);
        Assert.Equal(running.FirstTokenAt, viewModel.SelectedActivity?.FirstTokenAt);
    }

    [Fact]
    public async Task A_new_actionable_turn_is_followed_without_discarding_an_older_retryable_turn()
    {
        Bot bot = CreateBot("Bot");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView failed = CreateTurn(bot, BotTurnStatus.Failed, now.AddMinutes(-1));
        await using var session = new ActivityClientSession([bot], [failed]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        TurnView running = CreateTurn(bot, BotTurnStatus.Running, now);
        session.SetDurable(running);

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            running.TurnId, bot.Id, running.Protocol, running.Model));

        Assert.Equal(2, viewModel.Turns.Count);
        Assert.Equal(running.TurnId, viewModel.SelectedActivity?.TurnId);
        Assert.Contains(viewModel.Turns, turn => turn.TurnId == failed.TurnId && TurnActivityPolicy.CanRetry(turn));
    }

    [Fact]
    public async Task Manual_activity_selection_survives_an_unrelated_turn_refresh()
    {
        Bot bot = CreateBot("Bot");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView running = CreateTurn(bot, BotTurnStatus.Running, now);
        TurnView failed = CreateTurn(bot, BotTurnStatus.Failed, now.AddMinutes(-1));
        await using var session = new ActivityClientSession([bot], [running, failed]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        viewModel.SelectedActivity = failed;
        session.SetDurable(running with { StartedAt = now.AddMilliseconds(10) });

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            running.TurnId, bot.Id, running.Protocol, running.Model));

        Assert.Equal(failed.TurnId, viewModel.SelectedActivity?.TurnId);
    }

    [Fact]
    public async Task Refreshed_selection_always_references_the_instance_in_the_turn_collection()
    {
        Bot bot = CreateBot("Bot");
        TurnView running = CreateTurn(bot, BotTurnStatus.Running, DateTimeOffset.UtcNow);
        await using var session = new ActivityClientSession([bot], [running]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        TurnView refreshed = running with { };
        session.SetDurable(refreshed);

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            running.TurnId, bot.Id, running.Protocol, running.Model));

        Assert.Same(refreshed, viewModel.SelectedActivity);
        Assert.Same(viewModel.Turns.Single(), viewModel.SelectedActivity);
    }

    [Fact]
    public async Task Turn_refresh_finishing_after_a_bot_switch_cannot_contaminate_the_new_selection()
    {
        Bot firstBot = CreateBot("First");
        Bot secondBot = CreateBot("Second");
        DateTimeOffset now = DateTimeOffset.UtcNow;
        TurnView firstQueued = CreateTurn(firstBot, BotTurnStatus.Queued, now);
        TurnView secondCompleted = CreateTurn(secondBot, BotTurnStatus.Completed, now);
        await using var session = new ActivityClientSession([firstBot, secondBot], [firstQueued, secondCompleted]);
        var refreshStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseRefresh = new TaskCompletionSource<TurnView?>(TaskCreationOptions.RunContinuationsAsynchronously);
        session.GetTurnOverride = (_, _) =>
        {
            refreshStarted.SetResult();
            return new ValueTask<TurnView?>(releaseRefresh.Task);
        };
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();

        Task refresh = viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            firstQueued.TurnId, firstBot.Id, firstQueued.Protocol, firstQueued.Model));
        await refreshStarted.Task;
        await viewModel.SelectBotAsync(secondBot);
        releaseRefresh.SetResult(firstQueued with { Status = BotTurnStatus.Running, StartedAt = now });
        await refresh;

        Assert.Equal(secondBot.Id, viewModel.SelectedBot?.Id);
        Assert.Equal(secondCompleted.TurnId, viewModel.SelectedActivity?.TurnId);
        Assert.DoesNotContain(viewModel.Turns, turn => turn.BotId == firstBot.Id);
    }

    [Fact]
    public async Task Turn_refresh_failure_publishes_a_safe_error_notice()
    {
        Bot bot = CreateBot("Bot");
        TurnView queued = CreateTurn(bot, BotTurnStatus.Queued, DateTimeOffset.UtcNow);
        await using var session = new ActivityClientSession([bot], [queued])
        {
            GetTurnOverride = (_, _) => ValueTask.FromException<TurnView?>(
                new InvalidOperationException("provider body with api-key-secret")),
        };
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Started(
            queued.TurnId, bot.Id, queued.Protocol, queued.Model));

        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Equal("Something unexpected went wrong. Please try again.", viewModel.Notice?.Message);
        Assert.DoesNotContain("api-key-secret", viewModel.Notice?.Message ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Terminal_timeline_refresh_still_completes_when_the_turn_row_refresh_fails()
    {
        Bot bot = CreateBot("Bot");
        TurnView running = CreateTurn(bot, BotTurnStatus.Running, DateTimeOffset.UtcNow);
        await using var session = new ActivityClientSession([bot], [running]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        ChatMessage completedMessage = CreateMessage(bot, "Completed reply");
        session.TimelineResult = [completedMessage];
        session.GetTurnOverride = (_, _) => ValueTask.FromException<TurnView?>(
            new InvalidOperationException("durable turn read failed with api-key-secret"));
        int timelineCallsBeforeTerminal = session.LoadTimelineCalls;

        await viewModel.ProjectRuntimeEvent(new ChatRuntimeEvent.Completed(
            running.TurnId, bot.Id, running.Protocol, running.Model, completedMessage.Revision.Content, null));

        Assert.Equal(timelineCallsBeforeTerminal + 1, session.LoadTimelineCalls);
        Assert.Same(completedMessage, Assert.Single(viewModel.Timeline));
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Equal("Something unexpected went wrong. Please try again.", viewModel.Notice?.Message);
        Assert.DoesNotContain("api-key-secret", viewModel.Notice?.Message ?? string.Empty, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Windows_session_forwards_get_turn_and_logs_directory_to_the_host()
    {
        string directory = Path.Combine(Path.GetTempPath(), "Amira.WinUI.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            WindowsClientHost host = await WindowsClientHost.StartAsync(
                new NullRuntimeSink(), directory, TestContext.Current.CancellationToken);
            await using var session = new WindowsClientSession(host);

            TurnView? turn = await session.GetTurnAsync(BotTurnId.New(), TestContext.Current.CancellationToken);

            Assert.Null(turn);
            Assert.Equal(Path.Combine(directory, "logs"), session.LogsDirectory);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    private static Bot CreateBot(string name) => Bot.Create(
        BotProfile.Create(name, $"{name} description", $"{name} instructions"),
        ModelProfile.Create(ProviderConnectionId.New(), "test-model", new GenerationOptions()));

    private static ChatMessage CreateMessage(Bot bot, string content)
    {
        MessageId messageId = MessageId.New();
        MessageRevision revision = MessageRevision.Create(messageId, content);
        return new ChatMessage(
            messageId,
            bot.DirectChatId,
            MessageAuthor.Bot,
            revision,
            revision.CreatedAt,
            MessageStatus.Committed);
    }

    private static TurnView CreateTurn(
        Bot bot,
        BotTurnStatus status,
        DateTimeOffset queuedAt) => new(
            BotTurnId.New(),
            bot.Id,
            bot.DirectChatId,
            bot.ModelProfile.Id,
            bot.ModelProfile.ConnectionId,
            ProviderProtocol.OpenAIResponses,
            bot.ModelProfile.Model,
            1,
            status,
            queuedAt,
            status == BotTurnStatus.Running ? queuedAt : null,
            null,
            status is BotTurnStatus.Completed or BotTurnStatus.Failed or BotTurnStatus.Cancelled ? queuedAt : null,
            false,
            status == BotTurnStatus.Failed
                ? new AmiraError("test_failure", ErrorCategory.Provider, "The test turn failed.")
                : null,
            null,
            null);

    private sealed class ActivityClientSession : IClientSession
    {
        private readonly IReadOnlyList<Bot> _bots;
        private readonly Dictionary<BotId, IReadOnlyList<TurnView>> _turnsByBot;
        private readonly Dictionary<BotTurnId, TurnView> _durableTurns;

        public ActivityClientSession(IReadOnlyList<Bot> bots, IReadOnlyList<TurnView> turns)
        {
            _bots = bots;
            _turnsByBot = turns.GroupBy(turn => turn.BotId).ToDictionary(group => group.Key, group => (IReadOnlyList<TurnView>)[.. group]);
            _durableTurns = turns.ToDictionary(turn => turn.TurnId);
        }

        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();
        public string LogsDirectory { get; } = @"D:\Amira\logs";
        public int GetTurnCalls { get; private set; }
        public int QueryTurnCalls { get; private set; }
        public int LoadTimelineCalls { get; private set; }
        public IReadOnlyList<ChatMessage> TimelineResult { get; set; } = [];
        public Func<BotTurnId, CancellationToken, ValueTask<TurnView?>>? GetTurnOverride { get; set; }

        public void SetDurable(TurnView turn) => _durableTurns[turn.TurnId] = turn;

        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(_bots);

        public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<ProviderConnection>>([]);

        public ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default)
        {
            GetTurnCalls++;
            return GetTurnOverride?.Invoke(turnId, cancellationToken)
                ?? ValueTask.FromResult(_durableTurns.GetValueOrDefault(turnId));
        }

        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default)
        {
            QueryTurnCalls++;
            IReadOnlyList<TurnView> turns = query.BotId is { } botId && _turnsByBot.TryGetValue(botId, out IReadOnlyList<TurnView>? items)
                ? items
                : [];
            return ValueTask.FromResult(new TurnPage(turns, null));
        }

        public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default)
        {
            LoadTimelineCalls++;
            return ValueTask.FromResult(TimelineResult);
        }

        public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class NullRuntimeSink : IChatRuntimeEventSink
    {
        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default) =>
            ValueTask.CompletedTask;
    }
}
