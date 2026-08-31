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
        ArgumentNullException.ThrowIfNull(launcher);
        bool launched;
        try { launched = await launcher.LaunchAsync(logsDirectory); }
        catch (Exception) { throw OpenFailed(); }
        if (!launched) throw OpenFailed();
    }

    private static AmiraException OpenFailed() => new(new(
        AmiraErrorCodes.LogsFolderOpenFailed,
        ErrorCategory.Infrastructure,
        "The logs folder could not be opened."));
}
