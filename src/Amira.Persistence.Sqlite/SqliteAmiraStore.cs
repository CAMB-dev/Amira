using System.Diagnostics;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using SQLite.Framework;
using SQLite.Framework.Enums;
using SQLite.Framework.Exceptions;
using SQLite.Framework.Generated;

namespace Amira.Persistence.Sqlite;

/// <summary>SQLite.Framework-backed, source-generated persistence for Amira Core.</summary>
public sealed partial class SqliteAmiraStore : IChatStore, IWorkspaceStore, IDisposable
{
    private const int BusyTimeoutMilliseconds = 5_000;

    private readonly SQLiteDatabase _database;
    private readonly SemaphoreSlim _initializationGate = new(1, 1);
    private volatile bool _initialized;
    private bool _disposed;

    public SqliteAmiraStore(string databasePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(databasePath);
        SQLiteOptions options = new SQLiteOptionsBuilder(databasePath)
            .UseWalMode()
            .UseGeneratedMaterializers()
            .DisableReflectionFallback()
            .Build();
        _database = new SQLiteDatabase(options);
    }

    public async ValueTask InitializeAsync(CancellationToken cancellationToken = default)
    {
        ThrowIfDisposed();
        if (_initialized)
        {
            return;
        }

        await _initializationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_initialized)
            {
                return;
            }

            _database.Pragmas.BusyTimeout = BusyTimeoutMilliseconds;
            await SqliteSchema.MigrateAsync(_database, cancellationToken).ConfigureAwait(false);
            _initialized = true;
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
        finally
        {
            _initializationGate.Release();
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        _database.Dispose();
        _initializationGate.Dispose();
    }

    private async ValueTask EnsureInitializedAsync(CancellationToken cancellationToken)
    {
        ThrowIfDisposed();
        if (!_initialized)
        {
            await InitializeAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(_disposed, this);

    private static int WriteProtocol(ProviderProtocol value) => value switch
    {
        ProviderProtocol.OpenAIChatCompatible => 0,
        ProviderProtocol.OpenAIResponses => 1,
        ProviderProtocol.AnthropicMessages => 2,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown provider protocol."),
    };

    private static ProviderProtocol ReadProtocol(int value) => value switch
    {
        0 => ProviderProtocol.OpenAIChatCompatible,
        1 => ProviderProtocol.OpenAIResponses,
        2 => ProviderProtocol.AnthropicMessages,
        _ => throw InvalidDatabaseValue(),
    };

    private static int WriteTurnStatus(BotTurnStatus value) => value switch
    {
        BotTurnStatus.Queued => 0,
        BotTurnStatus.Running => 1,
        BotTurnStatus.Completed => 2,
        BotTurnStatus.Failed => 3,
        BotTurnStatus.Cancelled => 4,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown turn status."),
    };

    private static BotTurnStatus ReadTurnStatus(int value) => value switch
    {
        0 => BotTurnStatus.Queued,
        1 => BotTurnStatus.Running,
        2 => BotTurnStatus.Completed,
        3 => BotTurnStatus.Failed,
        4 => BotTurnStatus.Cancelled,
        _ => throw InvalidDatabaseValue(),
    };

    private static int WriteMessageAuthor(MessageAuthor value) => value switch
    {
        MessageAuthor.Human => 0,
        MessageAuthor.Bot => 1,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown message author."),
    };

    private static MessageAuthor ReadMessageAuthor(int value) => value switch
    {
        0 => MessageAuthor.Human,
        1 => MessageAuthor.Bot,
        _ => throw InvalidDatabaseValue(),
    };

    private static int WriteMessageStatus(MessageStatus value) => value switch
    {
        MessageStatus.Committed => 0,
        MessageStatus.Deleted => 1,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown message status."),
    };

    private static MessageStatus ReadMessageStatus(int value) => value switch
    {
        0 => MessageStatus.Committed,
        1 => MessageStatus.Deleted,
        _ => throw InvalidDatabaseValue(),
    };

    private static int WriteErrorCategory(ErrorCategory value) => value switch
    {
        ErrorCategory.Input => 0,
        ErrorCategory.Configuration => 1,
        ErrorCategory.DomainRule => 2,
        ErrorCategory.NotFound => 3,
        ErrorCategory.Concurrency => 4,
        ErrorCategory.Provider => 5,
        ErrorCategory.Persistence => 6,
        ErrorCategory.Infrastructure => 7,
        _ => throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown error category."),
    };

    private static ErrorCategory ReadErrorCategory(int value) => value switch
    {
        0 => ErrorCategory.Input,
        1 => ErrorCategory.Configuration,
        2 => ErrorCategory.DomainRule,
        3 => ErrorCategory.NotFound,
        4 => ErrorCategory.Concurrency,
        5 => ErrorCategory.Provider,
        6 => ErrorCategory.Persistence,
        7 => ErrorCategory.Infrastructure,
        _ => throw InvalidDatabaseValue(),
    };

    private static void WriteParentContext(BotTurnRow row, ActivityContext context)
    {
        if (context == default)
        {
            return;
        }

        row.ParentTraceId = context.TraceId.ToHexString();
        row.ParentSpanId = context.SpanId.ToHexString();
        row.ParentTraceFlags = (int)context.TraceFlags;
        row.ParentTraceState = context.TraceState;
        row.ParentIsRemote = context.IsRemote;
    }

    private static ActivityContext ReadParentContext(BotTurnRow row)
    {
        if (row.ParentTraceId is null
            && row.ParentSpanId is null
            && row.ParentTraceFlags is null
            && row.ParentTraceState is null
            && row.ParentIsRemote is null)
        {
            return default;
        }

        if (row.ParentTraceId is null
            || row.ParentSpanId is null
            || row.ParentTraceFlags is not (0 or 1)
            || row.ParentIsRemote is null)
        {
            throw InvalidDatabaseValue();
        }

        try
        {
            var traceId = ActivityTraceId.CreateFromString(row.ParentTraceId.AsSpan());
            var spanId = ActivitySpanId.CreateFromString(row.ParentSpanId.AsSpan());
            if (traceId == default || spanId == default)
            {
                throw InvalidDatabaseValue();
            }

            return new ActivityContext(
                traceId,
                spanId,
                (ActivityTraceFlags)row.ParentTraceFlags.Value,
                row.ParentTraceState,
                row.ParentIsRemote.Value);
        }
        catch (ArgumentOutOfRangeException)
        {
            throw InvalidDatabaseValue();
        }
    }

    private static AmiraException PersistenceFailure(SQLiteException exception) => new(new(
        AmiraErrorCodes.PersistenceFailed,
        ErrorCategory.Persistence,
        "The persistence operation failed.",
        exception.Result is SQLiteResult.Busy or SQLiteResult.Locked));

    private static AmiraException InvalidDatabaseValue() => new(new(
        AmiraErrorCodes.InvalidPersistedValue,
        ErrorCategory.Persistence,
        "Persisted data contains an unsupported value."));

    private static void RequireSingleRow(int rows)
    {
        if (rows != 1)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.PersistenceRowCount,
                ErrorCategory.Persistence,
                "A persistence operation affected an unexpected number of rows."));
        }
    }
}
