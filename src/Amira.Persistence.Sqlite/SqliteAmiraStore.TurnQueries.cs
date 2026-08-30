using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using SQLite.Framework.Exceptions;
using SQLite.Framework.Extensions;

namespace Amira.Persistence.Sqlite;

public sealed partial class SqliteAmiraStore
{
    public async ValueTask<TurnView?> GetTurnAsync(
        BotTurnId turnId,
        CancellationToken cancellationToken = default)
    {
        if (turnId.IsEmpty)
        {
            throw InvalidTurnQuery();
        }

        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            BotTurnRow? row = await _database.Table<BotTurnRow>()
                .SingleOrDefaultAsync(item => item.TurnId == turnId.Value, cancellationToken)
                .ConfigureAwait(false);
            return row is null ? null : ToTurnView(row);
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

    public async ValueTask<TurnPage> QueryTurnsAsync(
        TurnQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);

            bool filterByBot = query.BotId.HasValue;
            bool filterByChat = query.ChatId.HasValue;
            bool filterByStatus = query.Status.HasValue;
            bool hasCursor = query.Before.HasValue;
            string botId = query.BotId?.Value ?? string.Empty;
            string chatId = query.ChatId?.Value ?? string.Empty;
            int status = query.Status is { } statusValue ? WriteTurnStatus(statusValue) : 0;
            DateTimeOffset beforeQueuedAt = query.Before?.QueuedAt ?? default;
            string beforeTurnId = query.Before?.TurnId.Value ?? string.Empty;

            List<BotTurnRow> rows = await _database.Table<BotTurnRow>()
                .Where(row =>
                    (!filterByBot || row.BotId == botId)
                    && (!filterByChat || row.ChatId == chatId)
                    && (!filterByStatus || row.Status == status)
                    && (!hasCursor
                        || row.QueuedAt < beforeQueuedAt
                        || row.QueuedAt == beforeQueuedAt
                            && string.Compare(row.TurnId, beforeTurnId, StringComparison.Ordinal) < 0))
                .OrderByDescending(row => row.QueuedAt)
                .ThenByDescending(row => row.TurnId)
                .Take(query.PageSize + 1)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            bool hasMore = rows.Count > query.PageSize;
            int itemCount = Math.Min(rows.Count, query.PageSize);
            var items = new TurnView[itemCount];
            for (int index = 0; index < itemCount; index++)
            {
                items[index] = ToTurnView(rows[index]);
            }

            TurnCursor? nextCursor = hasMore
                ? new TurnCursor(items[^1].QueuedAt, items[^1].TurnId)
                : null;
            return new TurnPage(items, nextCursor);
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

    private static TurnView ToTurnView(BotTurnRow row)
    {
        if (string.IsNullOrWhiteSpace(row.TurnId)
            || string.IsNullOrWhiteSpace(row.BotId)
            || string.IsNullOrWhiteSpace(row.ChatId)
            || string.IsNullOrWhiteSpace(row.ModelProfileId)
            || string.IsNullOrWhiteSpace(row.ConnectionId)
            || string.IsNullOrWhiteSpace(row.Model)
            || row.Attempt <= 0
            || (row.Attempt == 1) != (row.RetryOfTurnId is null)
            || row.RetryOfTurnId is not null && string.IsNullOrWhiteSpace(row.RetryOfTurnId))
        {
            throw InvalidDatabaseValue();
        }

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
        else if (row.FailureMessage is not null
            || row.FailureTransient is not null
            || row.FailureCategory is not null)
        {
            throw InvalidDatabaseValue();
        }

        TurnUsage? usage;
        try
        {
            usage = row.InputTokens is null && row.OutputTokens is null
                ? null
                : new TurnUsage(row.InputTokens, row.OutputTokens);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw InvalidDatabaseValue();
        }

        return new TurnView(
            BotTurnId.Create(row.TurnId),
            BotId.Create(row.BotId),
            DirectChatId.Create(row.ChatId),
            ModelProfileId.Create(row.ModelProfileId),
            ProviderConnectionId.Create(row.ConnectionId),
            ReadProtocol(row.Protocol),
            row.Model,
            row.Attempt,
            ReadTurnStatus(row.Status),
            row.QueuedAt,
            row.StartedAt,
            row.FinishedAt,
            row.StopRequested,
            failure,
            row.RetryOfTurnId is null ? null : BotTurnId.Create(row.RetryOfTurnId),
            usage);
    }

    private static AmiraException InvalidTurnQuery() => new(new(
        AmiraErrorCodes.InvalidTurnQuery,
        ErrorCategory.Input,
        "A turn identifier is required."));
}
