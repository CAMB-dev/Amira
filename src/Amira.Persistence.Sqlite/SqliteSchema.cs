using Amira.Errors;
using SQLite.Framework;
using SQLite.Framework.Extensions;
using SQLite.Framework.Models;

namespace Amira.Persistence.Sqlite;

internal static class SqliteSchema
{
    internal const int LatestVersion = 4;

    internal static async Task MigrateAsync(SQLiteDatabase database, CancellationToken cancellationToken)
    {
        await ValidateRecordedVersionAsync(database, allowMissingHistory: true, cancellationToken).ConfigureAwait(false);

        _ = await database.Schema.Migrations()
            .Version(1, step => step
                .CreateTable<SchemaMigrationRow>()
                .CreateTable<BotRow>()
                .CreateTable<ProviderConnectionRow>()
                .CreateTable<BotProfileRow>()
                .CreateTable<ModelProfileRow>()
                .CreateTable<ConnectionHeaderRow>()
                .CreateTable<ModelOptionRow>()
                .CreateTable<ChatRow>()
                .CreateTable<MessageRow>()
                .CreateTable<MessageRevisionRow>()
                // A fresh run creates the latest shape because the runner skips same-run TableChanged steps.
                .CreateTable<BotTurnRow>()
                .CreateTable<TurnTriggerRow>()
                .CreateTable<TurnOptionRow>()
                .Insert(new SchemaMigrationRow { Version = 1, AppliedAt = DateTimeOffset.UtcNow }))
            .Version(2, step => step
                .TableChanged<BotTurnV2Row>()
                .Insert(new SchemaMigrationRow { Version = 2, AppliedAt = DateTimeOffset.UtcNow }))
            .Version(3, step => step
                .Run(context => AddFailureCategoryColumn(context.Database))
                .Insert(new SchemaMigrationRow { Version = 3, AppliedAt = DateTimeOffset.UtcNow }))
            .Version(4, step => step
                .Run(context => AddTraceContextColumns(context.Database))
                .Insert(new SchemaMigrationRow { Version = 4, AppliedAt = DateTimeOffset.UtcNow }))
            .MigrateAsync(cancellationToken)
            .ConfigureAwait(false);

        await ValidateRecordedVersionAsync(database, allowMissingHistory: false, cancellationToken).ConfigureAwait(false);
        await ValidateCurrentSchemaAsync(database, cancellationToken).ConfigureAwait(false);
    }

    private static async Task ValidateRecordedVersionAsync(
        SQLiteDatabase database,
        bool allowMissingHistory,
        CancellationToken cancellationToken)
    {
        int userVersion = database.Pragmas.UserVersion;
        if (userVersion > LatestVersion)
        {
            throw UnsupportedSchema();
        }

        bool hasHistory = await database.Schema.TableExistsAsync<SchemaMigrationRow>(cancellationToken).ConfigureAwait(false);
        if (!hasHistory)
        {
            if (allowMissingHistory && userVersion == 0)
            {
                return;
            }

            throw MigrationGap();
        }

        List<int> versions = await database.Table<SchemaMigrationRow>()
            .OrderBy(row => row.Version)
            .Select(row => row.Version)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);

        if (versions.Any(version => version > LatestVersion))
        {
            throw UnsupportedSchema();
        }

        if (versions.Count != userVersion)
        {
            throw MigrationGap();
        }

        for (int index = 0; index < versions.Count; index++)
        {
            if (versions[index] != index + 1)
            {
                throw MigrationGap();
            }
        }
    }

    private static async Task ValidateCurrentSchemaAsync(SQLiteDatabase database, CancellationToken cancellationToken)
    {
        if (database.Pragmas.UserVersion != LatestVersion)
        {
            throw UnsupportedSchema();
        }

        SQLiteModelValidationResult[] results =
        [
            await database.Schema.ValidateModelAsync<SchemaMigrationRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<BotRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<BotProfileRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<ProviderConnectionRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<ConnectionHeaderRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<ModelProfileRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<ModelOptionRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<ChatRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<MessageRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<MessageRevisionRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<BotTurnRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<TurnTriggerRow>(cancellationToken).ConfigureAwait(false),
            await database.Schema.ValidateModelAsync<TurnOptionRow>(cancellationToken).ConfigureAwait(false),
        ];

        if (results.Any(result => !result.IsValid))
        {
            throw new AmiraException(new(
                AmiraErrorCodes.PersistenceFailed,
                ErrorCategory.Persistence,
                "The database schema does not match the application model."));
        }
    }

    private static void AddFailureCategoryColumn(SQLiteDatabase database)
    {
        if (!database.Schema.ColumnExists<BotTurnV3Row>("failure_category"))
        {
            _ = database.Schema.AddColumn<BotTurnV3Row>(row => row.FailureCategory, default(int?));
        }
    }

    private static void AddTraceContextColumns(SQLiteDatabase database)
    {
        if (!database.Schema.ColumnExists<BotTurnRow>("parent_trace_id"))
        {
            _ = database.Schema.AddColumn<BotTurnRow>(row => row.ParentTraceId, default(string?));
        }

        if (!database.Schema.ColumnExists<BotTurnRow>("parent_span_id"))
        {
            _ = database.Schema.AddColumn<BotTurnRow>(row => row.ParentSpanId, default(string?));
        }

        if (!database.Schema.ColumnExists<BotTurnRow>("parent_trace_flags"))
        {
            _ = database.Schema.AddColumn<BotTurnRow>(row => row.ParentTraceFlags, default(int?));
        }

        if (!database.Schema.ColumnExists<BotTurnRow>("parent_trace_state"))
        {
            _ = database.Schema.AddColumn<BotTurnRow>(row => row.ParentTraceState, default(string?));
        }

        if (!database.Schema.ColumnExists<BotTurnRow>("parent_is_remote"))
        {
            _ = database.Schema.AddColumn<BotTurnRow>(row => row.ParentIsRemote, default(bool?));
        }
    }

    private static AmiraException UnsupportedSchema() => new(new(
        AmiraErrorCodes.UnsupportedSchemaVersion,
        ErrorCategory.Persistence,
        "The database was created by an unsupported application version."));

    private static AmiraException MigrationGap() => new(new(
        AmiraErrorCodes.SchemaMigrationGap,
        ErrorCategory.Persistence,
        "The database migration history is incomplete."));
}
