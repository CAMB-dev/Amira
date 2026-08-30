using Amira.Domain;
using Amira.Errors;

namespace Amira.Client.Composition.Windows;

public sealed class WorkspaceIdentityStore
{
    private readonly string _path;

    public WorkspaceIdentityStore(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The workspace identity path is invalid."));
        try { _path = Path.GetFullPath(path); }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The workspace identity path is invalid."));
        }
    }

    public async ValueTask<WorkspaceId> LoadOrCreateAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            if (File.Exists(_path))
            {
                string value = (await File.ReadAllTextAsync(_path, cancellationToken).ConfigureAwait(false)).Trim();
                try { return WorkspaceId.Create(value); }
                catch (Exception exception) when (exception is ArgumentException or AmiraException)
                {
                    throw new AmiraException(new(AmiraErrorCodes.WorkspaceIdentityInvalid, ErrorCategory.Persistence, "The persisted workspace identity is invalid."));
                }
            }

            WorkspaceId id = WorkspaceId.New();
            string directory = Path.GetDirectoryName(_path) ?? throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The workspace identity path is invalid."));
            string temporary = Path.Combine(directory, $".{Path.GetFileName(_path)}.{Guid.NewGuid():N}.tmp");
            try
            {
                await File.WriteAllTextAsync(temporary, id.Value, cancellationToken).ConfigureAwait(false);
                File.Move(temporary, _path, overwrite: false);
            }
            finally
            {
                try { if (File.Exists(temporary)) File.Delete(temporary); }
                catch (Exception) { }
            }
            return id;
        }
        catch (OperationCanceledException) { throw; }
        catch (AmiraException) { throw; }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new AmiraException(new(AmiraErrorCodes.WorkspaceIdentityPersistenceFailed, ErrorCategory.Persistence, "The workspace identity could not be persisted.", true));
        }
    }
}
