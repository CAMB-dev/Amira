using Amira.Client.WinUI;
using Amira.Errors;

namespace Amira.Client.WinUI.Tests;

public sealed class SettingsViewModelTests
{
    [Fact]
    public async Task Theme_change_is_persisted_before_it_is_published()
    {
        var store = new RecordingPreferencesStore();
        var viewModel = CreateViewModel(store: store);
        AppThemePreference? published = null;
        viewModel.ThemeChanged += value => published = value;

        bool changed = await viewModel.ChangeThemeAsync(AppThemePreference.Light);

        Assert.True(changed);
        Assert.Equal(AppThemePreference.Light, store.Saved?.Theme);
        Assert.Equal(AppThemePreference.Light, viewModel.ThemePreference);
        Assert.Equal(AppThemePreference.Light, published);
    }

    [Fact]
    public async Task Failed_theme_save_keeps_the_previous_theme_and_surfaces_the_product_error()
    {
        var failure = new AmiraException(new(
            AmiraErrorCodes.UiPreferencesSaveFailed,
            ErrorCategory.Persistence,
            "The interface settings could not be saved."));
        var viewModel = CreateViewModel(store: new RecordingPreferencesStore { Failure = failure });
        bool published = false;
        UserNotice? publishedNotice = null;
        viewModel.ThemeChanged += _ => published = true;
        viewModel.NoticePublished += notice => publishedNotice = notice;

        bool changed = await viewModel.ChangeThemeAsync(AppThemePreference.Light);

        Assert.False(changed);
        Assert.Equal(AppThemePreference.Dark, viewModel.ThemePreference);
        Assert.False(published);
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Contains(failure.Message, viewModel.Notice?.Message, StringComparison.Ordinal);
        Assert.Contains(AmiraErrorCodes.UiPreferencesSaveFailed, viewModel.Notice?.Message, StringComparison.Ordinal);
        Assert.Same(viewModel.Notice, publishedNotice);
    }

    [Fact]
    public async Task Folder_and_clipboard_actions_use_the_exact_non_secret_settings_values()
    {
        var launcher = new RecordingFolderLauncher();
        var clipboard = new RecordingClipboard();
        var viewModel = CreateViewModel(folderLauncher: launcher, clipboard: clipboard);

        Assert.True(await viewModel.OpenDataFolderAsync());
        Assert.True(await viewModel.OpenLogsFolderAsync());
        Assert.True(viewModel.CopyWorkspaceId());
        Assert.True(viewModel.CopyDiagnostics());

        Assert.Equal([@"D:\Amira", @"D:\Amira\logs"], launcher.Paths);
        Assert.Equal("workspace-1", clipboard.Values[0]);
        Assert.Contains("Amira 1.2.3", clipboard.Values[1], StringComparison.Ordinal);
        Assert.Contains("Workspace: workspace-1", clipboard.Values[1], StringComparison.Ordinal);
        Assert.DoesNotContain(@"D:\Amira", clipboard.Values[1], StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Data_folder_failure_has_a_specific_product_error()
    {
        var launcher = new RecordingFolderLauncher { Result = false };
        var viewModel = CreateViewModel(folderLauncher: launcher);

        bool opened = await viewModel.OpenDataFolderAsync();

        Assert.False(opened);
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Contains("The data folder could not be opened.", viewModel.Notice?.Message, StringComparison.Ordinal);
        Assert.Contains(AmiraErrorCodes.DataFolderOpenFailed, viewModel.Notice?.Message, StringComparison.Ordinal);
    }

    private static SettingsViewModel CreateViewModel(
        RecordingPreferencesStore? store = null,
        RecordingFolderLauncher? folderLauncher = null,
        RecordingClipboard? clipboard = null) => new(
        new SettingsEnvironmentInfo(
            "workspace-1",
            @"D:\Amira",
            @"D:\Amira\logs",
            "1.2.3",
            "Windows",
            ".NET 10",
            "X64"),
        UiPreferences.Default,
        store ?? new RecordingPreferencesStore(),
        folderLauncher ?? new RecordingFolderLauncher(),
        clipboard ?? new RecordingClipboard());

    private sealed class RecordingPreferencesStore : IUiPreferencesStore
    {
        public UiPreferences? Saved { get; private set; }
        public Exception? Failure { get; init; }

        public ValueTask<UiPreferences> LoadAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(UiPreferences.Default);

        public ValueTask SaveAsync(UiPreferences preferences, CancellationToken cancellationToken = default)
        {
            if (Failure is not null) return ValueTask.FromException(Failure);
            Saved = preferences;
            return ValueTask.CompletedTask;
        }
    }

    private sealed class RecordingFolderLauncher : IFolderLauncher
    {
        public List<string> Paths { get; } = [];
        public bool Result { get; init; } = true;

        public ValueTask<bool> LaunchAsync(string folderPath)
        {
            Paths.Add(folderPath);
            return ValueTask.FromResult(Result);
        }
    }

    private sealed class RecordingClipboard : ITextClipboard
    {
        public List<string> Values { get; } = [];

        public void SetText(string text) => Values.Add(text);
    }
}
