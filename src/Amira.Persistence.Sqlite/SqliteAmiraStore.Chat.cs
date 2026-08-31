using System.Diagnostics;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using SQLite.Framework;
using SQLite.Framework.Exceptions;
using SQLite.Framework.Extensions;

namespace Amira.Persistence.Sqlite;

public sealed partial class SqliteAmiraStore
{
    private const string ClaimNextTurnSql = """
        UPDATE "bot_turns"
        SET "status" = @running,
            "started_at" = @startedAt,
            "claim_token" = @claimToken
        WHERE "turn_id" = (
            SELECT candidate."turn_id"
            FROM "bot_turns" AS candidate
            WHERE candidate."bot_id" = @botId
              AND candidate."status" = @queued
              AND candidate."stop_requested" = 0
            ORDER BY candidate."queued_at", candidate."turn_id"
            LIMIT 1
        )
          AND "status" = @queued
          AND NOT EXISTS (
              SELECT 1
              FROM "bot_turns" AS active
              WHERE active."bot_id" = @botId
                AND active."status" = @running
          );
        """;

    public async ValueTask<QueuedMessageResult> CommitHumanMessageAndQueueTurnAsync(
        HumanMessageCommand command,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            MessageId messageId = MessageId.New();
            MessageRevision revision = MessageRevision.Create(messageId, command.Content);
            Message message = Message.Create(messageId, command.ChatId, MessageAuthor.Human, revision);
            BotTurn turn = BotTurn.Queue(
                command.BotId,
                command.ChatId,
                [messageId],
                command.ModelProfileSnapshot,
                revision.CreatedAt);

            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            await EnsureChatBelongsToBotAsync(command.ChatId, command.BotId, cancellationToken).ConfigureAwait(false);
            await EnsureModelProfileSnapshotMatchesBotAsync(command.BotId, command.ModelProfileSnapshot, cancellationToken).ConfigureAwait(false);
            await InsertMessageAndRevisionAsync(message, revision, cancellationToken).ConfigureAwait(false);
            await InsertTurnAsync(turn, command.ParentActivityContext, cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new QueuedMessageResult(message, revision, turn);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<ClaimedTurn?> TryClaimNextTurnAsync(
        BotId botId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            TurnClaimToken claimToken = TurnClaimToken.New();
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            SQLiteParameter[] parameters =
            [
                Parameter("@running", WriteTurnStatus(BotTurnStatus.Running)),
                Parameter("@startedAt", DateTimeOffset.UtcNow),
                Parameter("@claimToken", claimToken.Value),
                Parameter("@botId", botId.Value),
                Parameter("@queued", WriteTurnStatus(BotTurnStatus.Queued)),
            ];
            int rows = await _database.ExecuteAsync(ClaimNextTurnSql, parameters, cancellationToken).ConfigureAwait(false);
            if (rows == 0)
            {
                await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
                return null;
            }

            RequireSingleRow(rows);
            BotTurnRow? claimedRow = await _database.Table<BotTurnRow>()
                .SingleOrDefaultAsync(row => row.ClaimToken == claimToken.Value, cancellationToken)
                .ConfigureAwait(false);
            if (claimedRow is null)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.ClaimedTurnMissing,
                    ErrorCategory.Persistence,
                    "A claimed turn could not be reloaded."));
            }

            BotTurn turn = await LoadTurnAsync(claimedRow, cancellationToken).ConfigureAwait(false);
            ActivityContext parentContext = ReadParentContext(claimedRow);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new ClaimedTurn(turn, claimToken, parentContext);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask RecordFirstTokenAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            string id = turnId.Value;
            string token = claimToken.Value;
            int running = WriteTurnStatus(BotTurnStatus.Running);
            DateTimeOffset firstTokenAt = DateTimeOffset.UtcNow;
            int rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == id
                    && row.Status == running
                    && row.ClaimToken == token
                    && row.FirstTokenAt == null)
                .ExecuteUpdateAsync(
                    setters => setters.Set(row => row.FirstTokenAt, firstTokenAt),
                    cancellationToken)
                .ConfigureAwait(false);
            if (rows == 1)
            {
                return;
            }

            if (rows != 0)
            {
                RequireSingleRow(rows);
            }

            BotTurnRow? current = await _database.Table<BotTurnRow>()
                .SingleOrDefaultAsync(row => row.TurnId == id, cancellationToken)
                .ConfigureAwait(false);
            if (current is { FirstTokenAt: not null }
                && current.Status == running
                && current.ClaimToken == token)
            {
                return;
            }

            await RequireClaimedRowAsync(turnId, claimToken, rows, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask CompleteTurnAsync(
        CompleteTurnCommand command,
        TurnClaimToken claimToken,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(command);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            DateTimeOffset completedAt = command.CompletedAt ?? DateTimeOffset.UtcNow;
            string turnId = command.Turn.Id.Value;
            string token = claimToken.Value;
            int running = WriteTurnStatus(BotTurnStatus.Running);
            int completed = WriteTurnStatus(BotTurnStatus.Completed);
            int? inputTokens = command.Usage?.InputTokens;
            int? outputTokens = command.Usage?.OutputTokens;
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);

            int rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == turnId
                    && row.Status == running
                    && !row.StopRequested
                    && row.ClaimToken == token)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.Status, completed)
                    .Set(row => row.FinishedAt, completedAt)
                    .Set(row => row.InputTokens, inputTokens)
                    .Set(row => row.OutputTokens, outputTokens)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            await RequireClaimedRowAsync(command.Turn.Id, claimToken, rows, cancellationToken).ConfigureAwait(false);

            BotTurnRow persisted = await _database.Table<BotTurnRow>()
                .SingleAsync(row => row.TurnId == turnId, cancellationToken)
                .ConfigureAwait(false);
            DirectChatId chatId = DirectChatId.Create(persisted.ChatId);
            MessageId messageId = MessageId.New();
            MessageRevision revision = MessageRevision.Create(messageId, command.AssistantContent, completedAt);
            Message message = Message.Create(messageId, chatId, MessageAuthor.Bot, revision, completedAt);
            await InsertMessageAndRevisionAsync(message, revision, cancellationToken).ConfigureAwait(false);

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask FailTurnAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        AmiraError failure,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            string id = turnId.Value;
            string token = claimToken.Value;
            int running = WriteTurnStatus(BotTurnStatus.Running);
            int failed = WriteTurnStatus(BotTurnStatus.Failed);
            int failureCategory = WriteErrorCategory(failure.Category);
            DateTimeOffset finishedAt = DateTimeOffset.UtcNow;
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            int rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == id
                    && row.Status == running
                    && !row.StopRequested
                    && row.ClaimToken == token)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.Status, failed)
                    .Set(row => row.FinishedAt, finishedAt)
                    .Set(row => row.FailureCode, failure.Code)
                    .Set(row => row.FailureMessage, failure.Message)
                    .Set(row => row.FailureTransient, failure.IsTransient)
                    .Set(row => row.FailureCategory, failureCategory)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            await RequireClaimedRowAsync(turnId, claimToken, rows, cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask CancelClaimedTurnAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            string id = turnId.Value;
            string token = claimToken.Value;
            int running = WriteTurnStatus(BotTurnStatus.Running);
            int cancelled = WriteTurnStatus(BotTurnStatus.Cancelled);
            DateTimeOffset finishedAt = DateTimeOffset.UtcNow;
            int rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == id
                    && row.Status == running
                    && row.ClaimToken == token)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.StopRequested, true)
                    .Set(row => row.Status, cancelled)
                    .Set(row => row.FinishedAt, finishedAt)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            RequireClaimedRow(rows);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<DurableStopRequestResult> RequestStopAsync(BotTurnId turnId, CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            DateTimeOffset finishedAt = DateTimeOffset.UtcNow;
            string id = turnId.Value;
            int queued = WriteTurnStatus(BotTurnStatus.Queued);
            int running = WriteTurnStatus(BotTurnStatus.Running);
            int cancelled = WriteTurnStatus(BotTurnStatus.Cancelled);
            int rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == id && row.Status == queued)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.StopRequested, true)
                    .Set(row => row.Status, cancelled)
                    .Set(row => row.FinishedAt, finishedAt)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            if (rows == 1)
            {
                return new DurableStopRequestResult(StopRequested: true, Cancelled: true);
            }

            if (rows != 0)
            {
                RequireSingleRow(rows);
            }

            rows = await _database.Table<BotTurnRow>()
                .Where(row => row.TurnId == id && row.Status == running && !row.StopRequested)
                .ExecuteUpdateAsync(setters => setters.Set(row => row.StopRequested, true), cancellationToken)
                .ConfigureAwait(false);
            if (rows == 1)
            {
                return new DurableStopRequestResult(StopRequested: true, Cancelled: false);
            }

            if (rows != 0)
            {
                RequireSingleRow(rows);
            }

            bool exists = await _database.Table<BotTurnRow>()
                .AnyAsync(row => row.TurnId == id, cancellationToken)
                .ConfigureAwait(false);
            if (!exists)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.TurnNotFound,
                    ErrorCategory.NotFound,
                    "The requested turn was not found."));
            }

            return default;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask RecoverInterruptedTurnsAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            DateTimeOffset finishedAt = DateTimeOffset.UtcNow;
            int queued = WriteTurnStatus(BotTurnStatus.Queued);
            int running = WriteTurnStatus(BotTurnStatus.Running);
            int cancelled = WriteTurnStatus(BotTurnStatus.Cancelled);
            _ = await _database.Table<BotTurnRow>()
                .Where(row => row.Status == running && row.StopRequested)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.Status, cancelled)
                    .Set(row => row.FinishedAt, finishedAt)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            _ = await _database.Table<BotTurnRow>()
                .Where(row => row.Status == running && !row.StopRequested)
                .ExecuteUpdateAsync(setters => setters
                    .Set(row => row.Status, queued)
                    .Set(row => row.StartedAt, (DateTimeOffset?)null)
                    .Set(row => row.FirstTokenAt, (DateTimeOffset?)null)
                    .Set(row => row.ClaimToken, (string?)null), cancellationToken)
                .ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<BotTurn> RetryTurnAsync(
        BotTurnId turnId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            BotTurnRow? previousRow = await _database.Table<BotTurnRow>()
                .SingleOrDefaultAsync(row => row.TurnId == turnId.Value, cancellationToken)
                .ConfigureAwait(false);
            if (previousRow is null)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.TurnNotFound,
                    ErrorCategory.NotFound,
                    "The requested turn was not found."));
            }

            BotTurn previous = await LoadTurnAsync(previousRow, cancellationToken).ConfigureAwait(false);
            BotTurn retry = previous.Retry();
            await InsertTurnAsync(retry, ReadParentContext(previousRow), cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return retry;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    public async ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(
        DirectChatId chatId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            List<MessageRow> rows = await _database.Table<MessageRow>()
                .Where(row => row.ChatId == chatId.Value)
                .OrderBy(row => row.CreatedAt)
                .ThenBy(row => row.MessageId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);
            string[] revisionIds = rows.Select(row => row.CurrentRevisionId).ToArray();
            List<MessageRevisionRow> revisions = revisionIds.Length == 0
                ? []
                : await _database.Table<MessageRevisionRow>()
                    .Where(row => revisionIds.Contains(row.RevisionId))
                    .ToListAsync(cancellationToken)
                    .ConfigureAwait(false);
            Dictionary<string, MessageRevisionRow> revisionsById = revisions.ToDictionary(row => row.RevisionId, StringComparer.Ordinal);

            var result = new List<ChatMessage>(rows.Count);
            foreach (MessageRow row in rows)
            {
                if (!revisionsById.TryGetValue(row.CurrentRevisionId, out MessageRevisionRow? revisionRow))
                {
                    throw new AmiraException(new(
                        AmiraErrorCodes.InvalidRevision,
                        ErrorCategory.Persistence,
                        "A stored Message has no current revision."));
                }

                MessageId messageId = MessageId.Create(row.MessageId);
                MessageRevision revision = ToDomain(revisionRow, messageId);
                Message message = Message.Rehydrate(
                    messageId,
                    chatId,
                    ReadMessageAuthor(row.Author),
                    revision.Id,
                    row.CreatedAt,
                    ReadMessageStatus(row.Status));
                result.Add(ChatMessage.From(message, revision));
            }

            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return result;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException)
        {
            throw;
        }
        catch (SQLiteException exception)
        {
            throw PersistenceFailure(exception);
        }
    }

    private async Task EnsureChatBelongsToBotAsync(
        DirectChatId chatId,
        BotId botId,
        CancellationToken cancellationToken)
    {
        bool exists = await _database.Table<ChatRow>()
            .AnyAsync(row => row.ChatId == chatId.Value && row.BotId == botId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (!exists)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.ChatBotMismatch,
                ErrorCategory.DomainRule,
                "The direct chat does not belong to the specified Bot."));
        }
    }

    private async Task EnsureModelProfileSnapshotMatchesBotAsync(
        BotId botId,
        ModelProfileSnapshot snapshot,
        CancellationToken cancellationToken)
    {
        ModelProfileRow? model = await _database.Table<ModelProfileRow>()
            .SingleOrDefaultAsync(row => row.BotId == botId.Value, cancellationToken)
            .ConfigureAwait(false);
        ProviderConnectionRow? connection = await _database.Table<ProviderConnectionRow>()
            .SingleOrDefaultAsync(row => row.ConnectionId == snapshot.ConnectionId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (model is null || connection is null)
        {
            throw SnapshotMismatch();
        }

        Dictionary<string, string> options = await LoadModelOptionsAsync(model.ModelProfileId, cancellationToken).ConfigureAwait(false);
        ProviderProtocol persistedProtocol = ReadProtocol(connection.Protocol);
        if (model.ModelProfileId != snapshot.ModelProfileId.Value
            || model.ConnectionId != snapshot.ConnectionId.Value
            || model.Model != snapshot.Model
            || model.Temperature != snapshot.GenerationOptions.Temperature
            || model.MaxOutputTokens != snapshot.GenerationOptions.MaxOutputTokens
            || persistedProtocol != snapshot.Protocol
            || !OptionsMatch(options, snapshot.ProviderOptions))
        {
            throw SnapshotMismatch();
        }
    }

    private async Task<Dictionary<string, string>> LoadModelOptionsAsync(
        string modelProfileId,
        CancellationToken cancellationToken)
    {
        List<ModelOptionRow> rows = await _database.Table<ModelOptionRow>()
            .Where(row => row.ModelProfileId == modelProfileId)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        return MaterializeModelOptions(rows);
    }

    private static Dictionary<string, string> MaterializeModelOptions(IEnumerable<ModelOptionRow> rows)
    {
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (ModelOptionRow option in rows)
        {
            if (!options.TryAdd(option.Name, option.Value))
            {
                throw InvalidDatabaseValue();
            }
        }

        return options;
    }

    private static bool OptionsMatch(
        IReadOnlyDictionary<string, string> persisted,
        IReadOnlyDictionary<string, string> expected)
    {
        if (persisted.Count != expected.Count)
        {
            return false;
        }

        foreach ((string name, string value) in expected)
        {
            if (!persisted.TryGetValue(name, out string? persistedValue)
                || persistedValue != value)
            {
                return false;
            }
        }

        return true;
    }

    private static AmiraException SnapshotMismatch() => new(new(
        AmiraErrorCodes.SnapshotMismatch,
        ErrorCategory.DomainRule,
        "The model profile snapshot does not match the current Bot configuration."));

    private async Task InsertMessageAndRevisionAsync(
        Message message,
        MessageRevision revision,
        CancellationToken cancellationToken)
    {
        RequireSingleRow(await _database.Table<MessageRow>().AddAsync(new MessageRow
        {
            MessageId = message.Id.Value,
            ChatId = message.ChatId.Value,
            Author = WriteMessageAuthor(message.Author),
            CurrentRevisionId = revision.Id.Value,
            CreatedAt = message.CreatedAt,
            Status = WriteMessageStatus(message.Status),
        }, cancellationToken).ConfigureAwait(false));
        RequireSingleRow(await _database.Table<MessageRevisionRow>().AddAsync(new MessageRevisionRow
        {
            RevisionId = revision.Id.Value,
            MessageId = message.Id.Value,
            Content = revision.Content,
            CreatedAt = revision.CreatedAt,
            ReplacesRevisionId = revision.ReplacesRevisionId?.Value,
        }, cancellationToken).ConfigureAwait(false));
    }

    private async Task InsertTurnAsync(
        BotTurn turn,
        ActivityContext parentContext,
        CancellationToken cancellationToken)
    {
        var row = new BotTurnRow
        {
            TurnId = turn.Id.Value,
            BotId = turn.BotId.Value,
            ChatId = turn.ChatId.Value,
            Attempt = turn.Attempt,
            Status = WriteTurnStatus(turn.Status),
            StopRequested = turn.StopRequested,
            QueuedAt = turn.QueuedAt,
            StartedAt = turn.StartedAt,
            FirstTokenAt = turn.FirstTokenAt,
            FinishedAt = turn.FinishedAt,
            FailureCode = turn.Failure?.Code,
            FailureMessage = turn.Failure?.Message,
            FailureTransient = turn.Failure?.IsTransient,
            FailureCategory = turn.Failure is null ? null : WriteErrorCategory(turn.Failure.Value.Category),
            RetryOfTurnId = turn.RetryOfTurnId?.Value,
            ClaimToken = null,
            ConnectionId = turn.ModelProfileSnapshot.ConnectionId.Value,
            ModelProfileId = turn.ModelProfileSnapshot.ModelProfileId.Value,
            Protocol = WriteProtocol(turn.ModelProfileSnapshot.Protocol),
            Model = turn.ModelProfileSnapshot.Model,
            Temperature = turn.ModelProfileSnapshot.GenerationOptions.Temperature,
            MaxOutputTokens = turn.ModelProfileSnapshot.GenerationOptions.MaxOutputTokens,
            InputTokens = turn.Usage?.InputTokens,
            OutputTokens = turn.Usage?.OutputTokens,
        };
        WriteParentContext(row, parentContext);
        RequireSingleRow(await _database.Table<BotTurnRow>().AddAsync(row, cancellationToken).ConfigureAwait(false));

        TurnTriggerRow[] triggers = turn.TriggerMessageIds
            .Select((messageId, ordinal) => new TurnTriggerRow
            {
                TriggerId = ChildKey(turn.Id.Value, ordinal.ToString(System.Globalization.CultureInfo.InvariantCulture)),
                TurnId = turn.Id.Value,
                Ordinal = ordinal,
                MessageId = messageId.Value,
            })
            .ToArray();
        _ = await _database.Table<TurnTriggerRow>()
            .AddRangeAsync(triggers, runInTransaction: false, cancellationToken)
            .ConfigureAwait(false);

        TurnOptionRow[] options = turn.ModelProfileSnapshot.ProviderOptions
            .Select(item => new TurnOptionRow
            {
                OptionId = ChildKey(turn.Id.Value, item.Key),
                TurnId = turn.Id.Value,
                Name = item.Key,
                Value = item.Value,
            })
            .ToArray();
        if (options.Length > 0)
        {
            _ = await _database.Table<TurnOptionRow>()
                .AddRangeAsync(options, runInTransaction: false, cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async ValueTask<BotTurn> LoadTurnAsync(BotTurnRow row, CancellationToken cancellationToken)
    {
        List<TurnTriggerRow> triggerRows = await _database.Table<TurnTriggerRow>()
            .Where(item => item.TurnId == row.TurnId)
            .OrderBy(item => item.Ordinal)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        List<TurnOptionRow> optionRows = await _database.Table<TurnOptionRow>()
            .Where(item => item.TurnId == row.TurnId)
            .OrderBy(item => item.Name)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        Dictionary<string, string> options = MaterializeTurnOptions(optionRows);

        AmiraError? failure = null;
        if (row.FailureCode is not null)
        {
            if (row.FailureMessage is null || row.FailureTransient is null)
            {
                throw new AmiraException(new(
                    AmiraErrorCodes.IncompletePersistedError,
                    ErrorCategory.Persistence,
                    "A persisted turn error is incomplete."));
            }

            failure = new AmiraError(
                row.FailureCode,
                row.FailureCategory is null ? ErrorCategory.Provider : ReadErrorCategory(row.FailureCategory.Value),
                row.FailureMessage,
                row.FailureTransient.Value);
        }

        var snapshot = new ModelProfileSnapshot(
            ModelProfileId.Create(row.ModelProfileId),
            ProviderConnectionId.Create(row.ConnectionId),
            ReadProtocol(row.Protocol),
            row.Model,
            new GenerationOptions(row.Temperature, row.MaxOutputTokens),
            options);
        TurnUsage? usage = row.InputTokens is null && row.OutputTokens is null
            ? null
            : new TurnUsage(row.InputTokens, row.OutputTokens);
        var triggerMessageIds = new List<MessageId>(triggerRows.Count);
        var messageIds = new HashSet<string>(StringComparer.Ordinal);
        for (int index = 0; index < triggerRows.Count; index++)
        {
            TurnTriggerRow trigger = triggerRows[index];
            if (trigger.Ordinal != index || !messageIds.Add(trigger.MessageId))
            {
                throw InvalidDatabaseValue();
            }

            triggerMessageIds.Add(MessageId.Create(trigger.MessageId));
        }

        return BotTurn.Rehydrate(
            BotTurnId.Create(row.TurnId),
            BotId.Create(row.BotId),
            DirectChatId.Create(row.ChatId),
            triggerMessageIds,
            snapshot,
            row.Attempt,
            ReadTurnStatus(row.Status),
            row.QueuedAt,
            row.StartedAt,
            row.FirstTokenAt,
            row.FinishedAt,
            failure,
            usage,
            row.StopRequested,
            row.RetryOfTurnId is null ? null : BotTurnId.Create(row.RetryOfTurnId));
    }

    private static Dictionary<string, string> MaterializeTurnOptions(IEnumerable<TurnOptionRow> rows)
    {
        var options = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (TurnOptionRow option in rows)
        {
            if (!options.TryAdd(option.Name, option.Value))
            {
                throw InvalidDatabaseValue();
            }
        }

        return options;
    }

    private async Task RequireClaimedRowAsync(
        BotTurnId turnId,
        TurnClaimToken claimToken,
        int rows,
        CancellationToken cancellationToken)
    {
        if (rows == 1)
        {
            return;
        }

        if (rows != 0)
        {
            RequireSingleRow(rows);
        }

        BotTurnRow? row = await _database.Table<BotTurnRow>()
            .SingleOrDefaultAsync(item => item.TurnId == turnId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (row is not null
            && row.Status == WriteTurnStatus(BotTurnStatus.Running)
            && row.ClaimToken == claimToken.Value
            && row.StopRequested)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.TurnStopRequested,
                ErrorCategory.Concurrency,
                "The turn was stopped before its terminal result was committed."));
        }

        throw new AmiraException(new(
            AmiraErrorCodes.StaleClaim,
            ErrorCategory.Concurrency,
            "The turn claim is stale or invalid."));
    }

    private static void RequireClaimedRow(int rows)
    {
        if (rows != 1)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.StaleClaim,
                ErrorCategory.Concurrency,
                "The turn claim is stale or invalid."));
        }
    }

    private static MessageRevision ToDomain(MessageRevisionRow row, MessageId messageId) =>
        MessageRevision.Rehydrate(
            MessageRevisionId.Create(row.RevisionId),
            messageId,
            row.Content,
            row.CreatedAt,
            row.ReplacesRevisionId is null ? null : MessageRevisionId.Create(row.ReplacesRevisionId));

    private static SQLiteParameter Parameter(string name, object value) => new()
    {
        Name = name,
        Value = value,
    };
}
