using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using System.Diagnostics;

namespace Amira.Runtime.Tests;

internal sealed class InMemoryAmiraStore : IChatStore, IWorkspaceStore
{
    private readonly object _gate = new();
    private readonly Dictionary<BotId, Bot> _bots = [];
    private readonly Dictionary<ProviderConnectionId, ProviderConnection> _connections = [];
    private readonly Dictionary<DirectChatId, List<ChatMessage>> _timelines = [];
    private readonly Dictionary<BotTurnId, BotTurn> _turns = [];
    private readonly Dictionary<BotTurnId, TurnClaimToken> _claims = [];
    private readonly Dictionary<BotTurnId, ActivityContext> _parentActivityContexts = [];
    private readonly List<BotTurnId> _queue = [];
    private readonly List<AmiraError> _failures = [];
    private readonly List<BotTurn> _retried = [];
    private long _timestampOrdinal;
    private int _messageOrdinal;
    private int _turnOrdinal;
    private int _claimOrdinal;
    private int _botOrdinal;

    public InMemoryAmiraStore(Bot bot, ProviderConnection connection)
    {
        PrimaryChatId = bot.DirectChatId;
        AddBot(bot);
        AddConnection(connection);
    }

    private DirectChatId PrimaryChatId { get; }

    public List<ChatMessage> Timeline => _timelines[PrimaryChatId];
    public IReadOnlyList<AmiraError> Failures => _failures;
    public IReadOnlyList<BotTurn> Retried => _retried;
    public int CompletedCount { get; private set; }
    public int StopCount { get; private set; }
    public int CancelledCount { get; private set; }
    public AmiraException? CommitFailure { get; set; }

    public void AddBot(Bot bot)
    {
        lock (_gate)
        {
            _bots[bot.Id] = bot;
            _timelines.TryAdd(bot.DirectChatId, []);
        }
    }

    public void AddConnection(ProviderConnection connection)
    {
        lock (_gate)
        {
            _connections[connection.Id] = connection;
        }
    }

    public ChatMessage CreateMessage(DirectChatId chatId, MessageAuthor author, string content)
    {
        lock (_gate)
        {
            return CreateMessageCore(chatId, author, content, NextTimestamp());
        }
    }

    public IReadOnlyList<ChatMessage> TimelineFor(DirectChatId chatId)
    {
        lock (_gate)
        {
            return [.. _timelines[chatId]];
        }
    }

    public BotTurn GetTurn(BotTurnId turnId)
    {
        lock (_gate)
        {
            return _turns[turnId];
        }
    }

    public ValueTask<TurnView?> GetTurnAsync(
        BotTurnId turnId,
        CancellationToken cancellationToken = default)
    {
        if (turnId.IsEmpty)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.InvalidTurnQuery,
                ErrorCategory.Input,
                "A turn identifier is required."));
        }

        lock (_gate)
        {
            TurnView? view = _turns.TryGetValue(turnId, out BotTurn? turn)
                ? ToTurnView(turn)
                : null;
            return ValueTask.FromResult(view);
        }
    }

    public ValueTask<TurnPage> QueryTurnsAsync(
        TurnQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        lock (_gate)
        {
            IEnumerable<BotTurn> turns = _turns.Values;
            if (query.BotId is { } botId)
            {
                turns = turns.Where(turn => turn.BotId == botId);
            }

            if (query.ChatId is { } chatId)
            {
                turns = turns.Where(turn => turn.ChatId == chatId);
            }

            if (query.Status is { } status)
            {
                turns = turns.Where(turn => turn.Status == status);
            }

            if (query.Before is { } before)
            {
                turns = turns.Where(turn =>
                    turn.QueuedAt < before.QueuedAt
                    || turn.QueuedAt == before.QueuedAt
                        && string.Compare(turn.Id.Value, before.TurnId.Value, StringComparison.Ordinal) < 0);
            }

            TurnView[] candidates = turns
                .OrderByDescending(turn => turn.QueuedAt)
                .ThenByDescending(turn => turn.Id.Value, StringComparer.Ordinal)
                .Take(query.PageSize + 1)
                .Select(ToTurnView)
                .ToArray();
            bool hasMore = candidates.Length > query.PageSize;
            TurnView[] items = hasMore ? candidates[..query.PageSize] : candidates;
            TurnCursor? nextCursor = hasMore
                ? new TurnCursor(items[^1].QueuedAt, items[^1].TurnId)
                : null;
            return ValueTask.FromResult(new TurnPage(items, nextCursor));
        }
    }

    public ValueTask<QueuedMessageResult> CommitHumanMessageAndQueueTurnAsync(
        HumanMessageCommand command,
        CancellationToken cancellationToken = default)
    {
        if (CommitFailure is not null) throw CommitFailure;

        lock (_gate)
        {
            DateTimeOffset timestamp = NextTimestamp();
            ChatMessage chatMessage = CreateMessageCore(command.ChatId, MessageAuthor.Human, command.Content, timestamp);
            BotTurn turn = BotTurn.Rehydrate(
                NextTurnId(),
                command.BotId,
                command.ChatId,
                [chatMessage.Id],
                command.ModelProfileSnapshot,
                1,
                BotTurnStatus.Queued,
                timestamp,
                null,
                null,
                null,
                null,
                false,
                null);
            _timelines[command.ChatId].Add(chatMessage);
            _turns.Add(turn.Id, turn);
            _parentActivityContexts[turn.Id] = command.ParentActivityContext;
            _queue.Add(turn.Id);
            Message message = Message.Rehydrate(
                chatMessage.Id,
                chatMessage.ChatId,
                chatMessage.Author,
                chatMessage.Revision.Id,
                chatMessage.CreatedAt,
                chatMessage.Status);
            return ValueTask.FromResult(new QueuedMessageResult(message, chatMessage.Revision, turn));
        }
    }

    public ValueTask<ClaimedTurn?> TryClaimNextTurnAsync(BotId botId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            int queueIndex = _queue.FindIndex(turnId => _turns[turnId].BotId == botId);
            if (queueIndex < 0)
            {
                return ValueTask.FromResult<ClaimedTurn?>(null);
            }

            BotTurnId turnId = _queue[queueIndex];
            _queue.RemoveAt(queueIndex);
            BotTurn running = _turns[turnId].Start(NextTimestamp());
            var claimToken = new TurnClaimToken($"claim-{++_claimOrdinal}");
            _turns[turnId] = running;
            _claims[turnId] = claimToken;
            return ValueTask.FromResult<ClaimedTurn?>(new ClaimedTurn(running, claimToken, _parentActivityContexts[turnId]));
        }
    }

    public ValueTask CompleteTurnAsync(
        CompleteTurnCommand command,
        TurnClaimToken claimToken,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            BotTurn running = GetClaimedTurn(command.Turn.Id, claimToken);
            ThrowIfStopRequested(running);
            DateTimeOffset completedAt = command.CompletedAt ?? NextTimestamp();
            ChatMessage assistant = CreateMessageCore(
                running.ChatId,
                MessageAuthor.Bot,
                command.AssistantContent,
                completedAt);
            _turns[running.Id] = running.Complete(command.Usage, completedAt);
            _claims.Remove(running.Id);
            _timelines[running.ChatId].Add(assistant);
            CompletedCount++;
            return ValueTask.CompletedTask;
        }
    }

    public ValueTask FailTurnAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        AmiraError failure,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            BotTurn running = GetClaimedTurn(turnId, claimToken);
            ThrowIfStopRequested(running);
            _turns[turnId] = running.Fail(failure, NextTimestamp());
            _claims.Remove(turnId);
            _failures.Add(failure);
            return ValueTask.CompletedTask;
        }
    }

    public ValueTask CancelClaimedTurnAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            BotTurn running = GetClaimedTurn(turnId, claimToken);
            _turns[turnId] = running.Cancel(NextTimestamp());
            _claims.Remove(turnId);
            CancelledCount++;
            return ValueTask.CompletedTask;
        }
    }

    public ValueTask RequestStopAsync(BotTurnId turnId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            BotTurn turn = _turns[turnId];
            if (turn.StopRequested || turn.Status is BotTurnStatus.Completed or BotTurnStatus.Failed or BotTurnStatus.Cancelled)
            {
                return ValueTask.CompletedTask;
            }

            StopCount++;
            BotTurn stopRequested = turn.RequestStop();
            if (turn.Status == BotTurnStatus.Queued)
            {
                _turns[turnId] = stopRequested.Cancel(NextTimestamp());
                _queue.Remove(turnId);
                CancelledCount++;
            }
            else
            {
                _turns[turnId] = stopRequested;
            }

            return ValueTask.CompletedTask;
        }
    }

    public ValueTask RecoverInterruptedTurnsAsync(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            foreach (BotTurn running in _turns.Values.Where(static turn => turn.Status == BotTurnStatus.Running).ToArray())
            {
                _claims.Remove(running.Id);
                if (running.StopRequested)
                {
                    _turns[running.Id] = running.Cancel(NextTimestamp());
                    CancelledCount++;
                    continue;
                }

                BotTurn queued = BotTurn.Rehydrate(
                    running.Id,
                    running.BotId,
                    running.ChatId,
                    running.TriggerMessageIds,
                    running.ModelProfileSnapshot,
                    running.Attempt,
                    BotTurnStatus.Queued,
                    running.QueuedAt,
                    null,
                    null,
                    null,
                    null,
                    false,
                    running.RetryOfTurnId);
                _turns[running.Id] = queued;
                _queue.Add(running.Id);
            }

            return ValueTask.CompletedTask;
        }
    }

    public ValueTask<BotTurn> RetryTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            BotTurn terminal = _turns[turnId];
            BotTurn retried = BotTurn.Rehydrate(
                NextTurnId(),
                terminal.BotId,
                terminal.ChatId,
                terminal.TriggerMessageIds,
                terminal.ModelProfileSnapshot,
                terminal.Attempt + 1,
                BotTurnStatus.Queued,
                NextTimestamp(),
                null,
                null,
                null,
                null,
                false,
                terminal.Id);
            _turns.Add(retried.Id, retried);
            _parentActivityContexts[retried.Id] = _parentActivityContexts[terminal.Id];
            _queue.Add(retried.Id);
            _retried.Add(retried);
            return ValueTask.FromResult(retried);
        }
    }

    public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(
        DirectChatId chatId,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            return ValueTask.FromResult<IReadOnlyList<ChatMessage>>([.. _timelines[chatId]]);
        }
    }

    public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            int ordinal = ++_botOrdinal;
            DateTimeOffset createdAt = NextTimestamp();
            Bot bot = Bot.Rehydrate(
                BotId.Create($"created-bot-{ordinal}"),
                command.Profile,
                command.ModelProfile,
                DirectChatId.Create($"created-chat-{ordinal}"),
                createdAt,
                BotLifecycleState.Active);
            _bots.Add(bot.Id, bot);
            _timelines.Add(bot.DirectChatId, []);
            return ValueTask.FromResult(bot);
        }
    }

    public ValueTask<Bot?> GetBotAsync(BotId botId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            _bots.TryGetValue(botId, out Bot? bot);
            return ValueTask.FromResult(bot);
        }
    }

    public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            return ValueTask.FromResult<IReadOnlyList<Bot>>([.. _bots.Values.OrderBy(static bot => bot.Id.Value, StringComparer.Ordinal)]);
        }
    }

    public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            _bots[bot.Id] = bot;
            return ValueTask.FromResult(bot);
        }
    }

    public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            Bot archived = _bots[botId].Archive();
            _bots[botId] = archived;
            return ValueTask.FromResult(archived);
        }
    }

    public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            Bot restored = _bots[botId].Restore();
            _bots[botId] = restored;
            return ValueTask.FromResult(restored);
        }
    }

    public ValueTask SaveProviderConnectionAsync(
        ProviderConnection connection,
        CancellationToken cancellationToken = default)
    {
        AddConnection(connection);
        return ValueTask.CompletedTask;
    }

    public ValueTask<ProviderConnection?> GetProviderConnectionAsync(
        ProviderConnectionId connectionId,
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            _connections.TryGetValue(connectionId, out ProviderConnection? connection);
            return ValueTask.FromResult(connection);
        }
    }

    public ValueTask<IReadOnlyList<ProviderConnection>> ListProviderConnectionsAsync(
        CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            return ValueTask.FromResult<IReadOnlyList<ProviderConnection>>(
                [.. _connections.Values.OrderBy(static connection => connection.Id.Value, StringComparer.Ordinal)]);
        }
    }

    private ChatMessage CreateMessageCore(
        DirectChatId chatId,
        MessageAuthor author,
        string content,
        DateTimeOffset timestamp)
    {
        int ordinal = ++_messageOrdinal;
        var messageId = MessageId.Create($"message-{ordinal}");
        MessageRevision revision = MessageRevision.Rehydrate(
            MessageRevisionId.Create($"revision-{ordinal}"),
            messageId,
            content,
            timestamp,
            null);
        Message message = Message.Rehydrate(
            messageId,
            chatId,
            author,
            revision.Id,
            timestamp,
            MessageStatus.Committed);
        return ChatMessage.From(message, revision);
    }

    private BotTurn GetClaimedTurn(BotTurnId turnId, TurnClaimToken claimToken)
    {
        if (!_turns.TryGetValue(turnId, out BotTurn? turn)
            || !_claims.TryGetValue(turnId, out TurnClaimToken currentClaim)
            || currentClaim != claimToken)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.StaleClaim,
                ErrorCategory.Concurrency,
                "The turn claim is no longer current."));
        }

        return turn;
    }

    private static void ThrowIfStopRequested(BotTurn turn)
    {
        if (turn.StopRequested)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.TurnStopRequested,
                ErrorCategory.Concurrency,
                "The turn has a durable stop request."));
        }
    }

    private static TurnView ToTurnView(BotTurn turn) => new(
        turn.Id,
        turn.BotId,
        turn.ChatId,
        turn.ModelProfileSnapshot.ModelProfileId,
        turn.ModelProfileSnapshot.ConnectionId,
        turn.ModelProfileSnapshot.Protocol,
        turn.ModelProfileSnapshot.Model,
        turn.Attempt,
        turn.Status,
        turn.QueuedAt,
        turn.StartedAt,
        turn.FinishedAt,
        turn.StopRequested,
        turn.Failure,
        turn.RetryOfTurnId,
        turn.Usage);

    private BotTurnId NextTurnId() => BotTurnId.Create($"turn-{++_turnOrdinal}");

    private DateTimeOffset NextTimestamp() => DateTimeOffset.UnixEpoch.AddTicks(++_timestampOrdinal);
}
