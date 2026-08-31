using Amira.Errors;
using Windows.Storage;
using Windows.System;

namespace Amira.Client.WinUI;

public interface IFolderLauncher
{
    ValueTask<bool> LaunchAsync(string folderPath);
}

public sealed class WindowsFolderLauncher : IFolderLauncher
{
    public async ValueTask<bool> LaunchAsync(string folderPath)
    {
        StorageFolder folder = await StorageFolder.GetFolderFromPathAsync(folderPath);
        return await Launcher.LaunchFolderAsync(folder);
    }
}

public static class LogsFolderLaunchPolicy
{
    public static async Task OpenAsync(IFolderLauncher launcher, string logsDirectory)
    {
        await FolderLaunchPolicy.OpenAsync(
            launcher,
            logsDirectory,
            AmiraErrorCodes.LogsFolderOpenFailed,
            "The logs folder could not be opened.");
    }
}

public static class DataFolderLaunchPolicy
{
    public static async Task OpenAsync(IFolderLauncher launcher, string dataDirectory)
    {
        await FolderLaunchPolicy.OpenAsync(
            launcher,
            dataDirectory,
            AmiraErrorCodes.DataFolderOpenFailed,
            "The data folder could not be opened.");
    }
}

internal static class FolderLaunchPolicy
{
    public static async Task OpenAsync(IFolderLauncher launcher, string folderPath, string errorCode, string errorMessage)
    {
        ArgumentNullException.ThrowIfNull(launcher);
        bool launched;
        try { launched = await launcher.LaunchAsync(folderPath); }
        catch (Exception) { throw OpenFailed(errorCode, errorMessage); }
        if (!launched) throw OpenFailed(errorCode, errorMessage);
    }

    private static AmiraException OpenFailed(string errorCode, string errorMessage) => new(new(
        errorCode,
        ErrorCategory.Infrastructure,
        errorMessage));
}
