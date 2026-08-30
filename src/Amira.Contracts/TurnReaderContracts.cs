using Amira.Domain;
using Amira.Errors;

namespace Amira.Contracts;

/// <summary>Read-only, host-safe projection of one durable Bot turn.</summary>
public sealed record TurnView(
    BotTurnId TurnId,
    BotId BotId,
    DirectChatId ChatId,
    ModelProfileId ModelProfileId,
    ProviderConnectionId ConnectionId,
    ProviderProtocol Protocol,
    string Model,
    int Attempt,
    BotTurnStatus Status,
    DateTimeOffset QueuedAt,
    DateTimeOffset? StartedAt,
    DateTimeOffset? FinishedAt,
    bool StopRequested,
    AmiraError? Failure,
    BotTurnId? RetryOfTurnId,
    TurnUsage? Usage);

/// <summary>Exclusive keyset boundary for the fixed QueuedAt/TurnId descending order.</summary>
public readonly record struct TurnCursor(DateTimeOffset QueuedAt, BotTurnId TurnId);

/// <summary>Optional single-value filters and keyset paging for durable turns.</summary>
public sealed record TurnQuery
{
    public const int DefaultPageSize = 50;
    public const int MaximumPageSize = 100;

    public TurnQuery(
        BotId? botId = null,
        DirectChatId? chatId = null,
        BotTurnStatus? status = null,
        int pageSize = DefaultPageSize,
        TurnCursor? before = null)
    {
        if (pageSize is <= 0 or > MaximumPageSize)
        {
            throw InvalidQuery("Turn page size must be between 1 and 100.");
        }

        if (botId is { IsEmpty: true } || chatId is { IsEmpty: true })
        {
            throw InvalidQuery("Turn filters require non-empty identifiers.");
        }

        if (status is { } statusValue
            && statusValue is not (BotTurnStatus.Queued
                or BotTurnStatus.Running
                or BotTurnStatus.Completed
                or BotTurnStatus.Failed
                or BotTurnStatus.Cancelled))
        {
            throw InvalidQuery("The turn status filter is unsupported.");
        }

        if (before is { TurnId.IsEmpty: true })
        {
            throw InvalidQuery("A turn cursor requires a turn identifier.");
        }

        BotId = botId;
        ChatId = chatId;
        Status = status;
        PageSize = pageSize;
        Before = before;
    }

    public BotId? BotId { get; }
    public DirectChatId? ChatId { get; }
    public BotTurnStatus? Status { get; }
    public int PageSize { get; }
    public TurnCursor? Before { get; }

    private static AmiraException InvalidQuery(string message) => new(new(
        AmiraErrorCodes.InvalidTurnQuery,
        ErrorCategory.Input,
        message));
}

/// <summary>A bounded newest-first page. NextCursor is null when no older rows remain.</summary>
public sealed record TurnPage(IReadOnlyList<TurnView> Items, TurnCursor? NextCursor);

/// <summary>Narrow read seam for restoring durable turn state without exposing execution metadata.</summary>
public interface ITurnReader
{
    ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default);

    ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default);
}
