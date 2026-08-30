using Amira.Errors;

namespace Amira.Client.Composition.Windows;

public sealed class ClientPaths
{
    private ClientPaths(string rootDirectory, string databasePath, string logsDirectory, string workspaceIdentityPath) =>
        (RootDirectory, DatabasePath, LogsDirectory, WorkspaceIdentityPath) = (rootDirectory, databasePath, logsDirectory, workspaceIdentityPath);

    public string RootDirectory { get; }
    public string DatabasePath { get; }
    public string LogsDirectory { get; }
    public string WorkspaceIdentityPath { get; }

    public static ClientPaths Create(string? rootDirectory = null)
    {
        if (rootDirectory is not null && string.IsNullOrWhiteSpace(rootDirectory))
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The client data directory is invalid."));
        string root = rootDirectory ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Amira");
        try
        {
            root = Path.GetFullPath(root);
            Directory.CreateDirectory(root);
            string logs = Path.Combine(root, "logs");
            Directory.CreateDirectory(logs);
            return new ClientPaths(root, Path.Combine(root, "amira.db"), logs, Path.Combine(root, "workspace.id"));
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The client data directory is invalid."));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new AmiraException(new(AmiraErrorCodes.ClientPathCreationFailed, ErrorCategory.Infrastructure, "The client data directories could not be created.", true));
        }
    }
}
