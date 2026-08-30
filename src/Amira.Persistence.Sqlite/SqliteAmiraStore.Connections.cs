using Amira.Domain;
using Amira.Errors;
using SQLite.Framework;
using SQLite.Framework.Exceptions;
using SQLite.Framework.Extensions;

namespace Amira.Persistence.Sqlite;

public sealed partial class SqliteAmiraStore
{
    public async ValueTask SaveProviderConnectionAsync(
        ProviderConnection connection,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(connection);
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);

            var row = new ProviderConnectionRow
            {
                ConnectionId = connection.Id.Value,
                Protocol = WriteProtocol(connection.Protocol),
                DisplayName = connection.DisplayName,
                BaseUrl = connection.BaseUrl.AbsoluteUri,
                CredentialReference = connection.CredentialReference.Value,
                DefaultModel = connection.DefaultModel,
                Enabled = connection.Enabled,
            };
            RequireSingleRow(await _database.Table<ProviderConnectionRow>()
                .UpsertAsync(row, upsert => upsert.OnConflict(item => item.ConnectionId).DoUpdateAll(), cancellationToken)
                .ConfigureAwait(false));

            _ = await _database.Table<ConnectionHeaderRow>()
                .Where(item => item.ConnectionId == connection.Id.Value)
                .ExecuteDeleteAsync(cancellationToken)
                .ConfigureAwait(false);

            ConnectionHeaderRow[] headers = connection.ExtraHeaders
                .Select(item => new ConnectionHeaderRow
                {
                    HeaderId = ChildKey(connection.Id.Value, item.Key),
                    ConnectionId = connection.Id.Value,
                    Name = item.Key,
                    Value = item.Value,
                })
                .ToArray();
            if (headers.Length > 0)
            {
                _ = await _database.Table<ConnectionHeaderRow>()
                    .AddRangeAsync(headers, runInTransaction: false, cancellationToken)
                    .ConfigureAwait(false);
            }

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

    public async ValueTask<ProviderConnection?> GetProviderConnectionAsync(
        ProviderConnectionId connectionId,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            ProviderConnection? connection = await LoadProviderConnectionAsync(connectionId, cancellationToken).ConfigureAwait(false);
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return connection;
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

    public async ValueTask<IReadOnlyList<ProviderConnection>> ListProviderConnectionsAsync(
        CancellationToken cancellationToken = default)
    {
        try
        {
            await EnsureInitializedAsync(cancellationToken).ConfigureAwait(false);
            await using SQLiteTransaction transaction = await _database.BeginTransactionAsync(cancellationToken);
            List<string> ids = await _database.Table<ProviderConnectionRow>()
                .OrderBy(item => item.DisplayName)
                .ThenBy(item => item.ConnectionId)
                .Select(item => item.ConnectionId)
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            var result = new List<ProviderConnection>(ids.Count);
            foreach (string id in ids)
            {
                ProviderConnection connection = await LoadProviderConnectionAsync(
                    ProviderConnectionId.Create(id),
                    cancellationToken).ConfigureAwait(false)
                    ?? throw new AmiraException(new(
                        AmiraErrorCodes.ConnectionLoadInconsistent,
                        ErrorCategory.Persistence,
                        "A provider connection disappeared while it was being loaded."));
                result.Add(connection);
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

    private async ValueTask<ProviderConnection?> LoadProviderConnectionAsync(
        ProviderConnectionId connectionId,
        CancellationToken cancellationToken)
    {
        ProviderConnectionRow? row = await _database.Table<ProviderConnectionRow>()
            .SingleOrDefaultAsync(item => item.ConnectionId == connectionId.Value, cancellationToken)
            .ConfigureAwait(false);
        if (row is null)
        {
            return null;
        }

        List<ConnectionHeaderRow> headerRows = await _database.Table<ConnectionHeaderRow>()
            .Where(item => item.ConnectionId == connectionId.Value)
            .OrderBy(item => item.Name)
            .ToListAsync(cancellationToken)
            .ConfigureAwait(false);
        var headers = new Dictionary<string, string>(headerRows.Count, StringComparer.Ordinal);
        foreach (ConnectionHeaderRow header in headerRows)
        {
            headers.Add(header.Name, header.Value);
        }

        return ProviderConnection.Rehydrate(
            connectionId,
            ReadProtocol(row.Protocol),
            row.DisplayName,
            new Uri(row.BaseUrl, UriKind.Absolute),
            CredentialReference.Create(row.CredentialReference),
            row.DefaultModel,
            headers,
            row.Enabled);
    }

    private static string ChildKey(string parentId, string name) => $"{parentId}:{name}";
}
