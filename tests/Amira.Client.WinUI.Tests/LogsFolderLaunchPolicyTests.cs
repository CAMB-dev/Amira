using Amira.Errors;

namespace Amira.Client.WinUI.Tests;

public sealed class LogsFolderLaunchPolicyTests
{
    private const string LogsDirectory = @"D:\private\amira\logs";

    [Fact]
    public async Task Successful_launch_passes_the_directory_as_data()
    {
        var launcher = new FakeFolderLauncher(result: true);

        await LogsFolderLaunchPolicy.OpenAsync(launcher, LogsDirectory);

        Assert.Equal(LogsDirectory, launcher.ReceivedFolderPath);
    }

    [Fact]
    public async Task False_launch_result_is_a_stable_product_error()
    {
        var launcher = new FakeFolderLauncher(result: false);

        AmiraException error = await Assert.ThrowsAsync<AmiraException>(
            () => LogsFolderLaunchPolicy.OpenAsync(launcher, LogsDirectory));

        Assert.Equal(AmiraErrorCodes.LogsFolderOpenFailed, error.Code);
        Assert.Equal("The logs folder could not be opened.", error.Message);
        Assert.DoesNotContain(LogsDirectory, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Launcher_exception_is_replaced_with_the_same_safe_product_error()
    {
        var launcher = new FakeFolderLauncher(
            failure: new InvalidOperationException($"Could not open {LogsDirectory} with secret details"));

        AmiraException error = await Assert.ThrowsAsync<AmiraException>(
            () => LogsFolderLaunchPolicy.OpenAsync(launcher, LogsDirectory));

        Assert.Equal(AmiraErrorCodes.LogsFolderOpenFailed, error.Code);
        Assert.Equal("The logs folder could not be opened.", error.Message);
        Assert.DoesNotContain(LogsDirectory, error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret details", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class FakeFolderLauncher(bool result = false, Exception? failure = null) : IFolderLauncher
    {
        public string? ReceivedFolderPath { get; private set; }

        public ValueTask<bool> LaunchAsync(string folderPath)
        {
            ReceivedFolderPath = folderPath;
            return failure is null
                ? ValueTask.FromResult(result)
                : ValueTask.FromException<bool>(failure);
        }
    }
}
