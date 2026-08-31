using System.ComponentModel;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;

namespace Amira.Client.WinUI;

public sealed record SettingsEnvironmentInfo(
    string WorkspaceId,
    string DataDirectory,
    string LogsDirectory,
    string AppVersion,
    string OperatingSystem,
    string Runtime,
    string Architecture)
{
    public static SettingsEnvironmentInfo Create(string workspaceId, string dataDirectory, string logsDirectory)
    {
        Version? version = typeof(App).Assembly.GetName().Version;
        return new(
            workspaceId,
            dataDirectory,
            logsDirectory,
            version?.ToString(3) ?? "Development",
            RuntimeInformation.OSDescription,
            RuntimeInformation.FrameworkDescription,
            RuntimeInformation.ProcessArchitecture.ToString());
    }

    public string DiagnosticText => string.Join(Environment.NewLine,
        $"Amira {AppVersion}",
        $"OS: {OperatingSystem}",
        $"Runtime: {Runtime}",
        $"Architecture: {Architecture}",
        $"Workspace: {WorkspaceId}");
}

public sealed class SettingsViewModel : INotifyPropertyChanged
{
    private readonly IUiPreferencesStore _preferencesStore;
    private readonly IFolderLauncher _folderLauncher;
    private readonly ITextClipboard _clipboard;
    private AppThemePreference _themePreference;
    private UserNotice? _notice;
    private bool _isBusy;

    public SettingsViewModel(
        SettingsEnvironmentInfo environment,
        UiPreferences preferences,
        IUiPreferencesStore preferencesStore,
        IFolderLauncher? folderLauncher = null,
        ITextClipboard? clipboard = null)
    {
        Environment = environment ?? throw new ArgumentNullException(nameof(environment));
        ArgumentNullException.ThrowIfNull(preferences);
        _themePreference = preferences.Theme;
        _preferencesStore = preferencesStore ?? throw new ArgumentNullException(nameof(preferencesStore));
        _folderLauncher = folderLauncher ?? new WindowsFolderLauncher();
        _clipboard = clipboard ?? new WindowsTextClipboard();
    }

    public SettingsEnvironmentInfo Environment { get; }
    public AppThemePreference ThemePreference
    {
        get => _themePreference;
        private set => Set(ref _themePreference, value);
    }
    public UserNotice? Notice
    {
        get => _notice;
        private set
        {
            if (!Set(ref _notice, value)) return;
            OnChanged(nameof(HasNotice));
        }
    }
    public bool HasNotice => Notice is not null;
    public bool IsBusy
    {
        get => _isBusy;
        private set => Set(ref _isBusy, value);
    }

    public event PropertyChangedEventHandler? PropertyChanged;
    public event Action<AppThemePreference>? ThemeChanged;
    public event Action<UserNotice>? NoticePublished;

    public async Task<bool> ChangeThemeAsync(AppThemePreference preference)
    {
        if (preference == ThemePreference) return true;
        if (IsBusy) return false;
        IsBusy = true;
        try
        {
            await _preferencesStore.SaveAsync(new UiPreferences(preference));
            ThemePreference = preference;
            ThemeChanged?.Invoke(preference);
            return true;
        }
        catch (Exception exception)
        {
            Publish(UserNotice.FromError(exception));
            return false;
        }
        finally { IsBusy = false; }
    }

    public Task<bool> OpenDataFolderAsync() => RunAsync(
        () => DataFolderLaunchPolicy.OpenAsync(_folderLauncher, Environment.DataDirectory),
        "Data folder opened.");

    public Task<bool> OpenLogsFolderAsync() => RunAsync(
        () => LogsFolderLaunchPolicy.OpenAsync(_folderLauncher, Environment.LogsDirectory),
        "Logs folder opened.");

    public bool CopyWorkspaceId() => Copy(Environment.WorkspaceId, "Workspace ID copied.");

    public bool CopyDiagnostics() => Copy(Environment.DiagnosticText, "Diagnostic information copied.");

    public void Report(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        Publish(UserNotice.FromError(exception));
    }

    public void DismissNotice() => Notice = null;

    private bool Copy(string text, string successMessage)
    {
        try
        {
            ClipboardWritePolicy.Write(_clipboard, text);
            Publish(UserNotice.Successful(successMessage));
            return true;
        }
        catch (Exception exception)
        {
            Publish(UserNotice.FromError(exception));
            return false;
        }
    }

    private async Task<bool> RunAsync(Func<Task> operation, string successMessage)
    {
        if (IsBusy) return false;
        IsBusy = true;
        try
        {
            await operation();
            Publish(UserNotice.Successful(successMessage));
            return true;
        }
        catch (Exception exception)
        {
            Publish(UserNotice.FromError(exception));
            return false;
        }
        finally { IsBusy = false; }
    }

    private void Publish(UserNotice notice)
    {
        Notice = notice;
        NoticePublished?.Invoke(notice);
    }

    private bool Set<T>(ref T field, T value, [CallerMemberName] string? propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        OnChanged(propertyName);
        return true;
    }

    private void OnChanged(string? propertyName) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}
