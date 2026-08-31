using System.Text.Json;
using System.Text.Json.Serialization;
using Amira.Errors;
using Microsoft.UI.Xaml;

namespace Amira.Client.WinUI;

public enum AppThemePreference
{
    System,
    Light,
    Dark,
}

public sealed record UiPreferences(AppThemePreference Theme)
{
    public static UiPreferences Default { get; } = new(AppThemePreference.Dark);
}

public interface IUiPreferencesStore
{
    ValueTask<UiPreferences> LoadAsync(CancellationToken cancellationToken = default);
    ValueTask SaveAsync(UiPreferences preferences, CancellationToken cancellationToken = default);
}

public sealed class JsonUiPreferencesStore : IUiPreferencesStore
{
    public const int CurrentSchemaVersion = 1;

    private readonly string _path;

    public JsonUiPreferencesStore(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) throw InvalidPath();
        try { _path = Path.GetFullPath(path); }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException) { throw InvalidPath(); }
    }

    public async ValueTask<UiPreferences> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(_path)) return UiPreferences.Default;

        try
        {
            await using FileStream stream = new(
                _path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 4096,
                FileOptions.Asynchronous | FileOptions.SequentialScan);
            UiPreferencesDocument? document = await JsonSerializer.DeserializeAsync(
                stream,
                UiPreferencesJsonContext.Default.UiPreferencesDocument,
                cancellationToken);
            if (document is not { SchemaVersion: CurrentSchemaVersion }) throw InvalidPreferences();
            AppThemePreference theme = document.Theme switch
            {
                nameof(AppThemePreference.System) => AppThemePreference.System,
                nameof(AppThemePreference.Light) => AppThemePreference.Light,
                nameof(AppThemePreference.Dark) => AppThemePreference.Dark,
                _ => throw InvalidPreferences(),
            };
            return new UiPreferences(theme);
        }
        catch (JsonException) { throw InvalidPreferences(); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.UiPreferencesLoadFailed,
                ErrorCategory.Persistence,
                "The interface settings could not be loaded.",
                true));
        }
    }

    public async ValueTask SaveAsync(UiPreferences preferences, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(preferences);
        string directory = Path.GetDirectoryName(_path) ?? throw InvalidPath();
        string temporaryPath = $"{_path}.tmp";
        try
        {
            Directory.CreateDirectory(directory);
            await using (FileStream stream = new(
                temporaryPath,
                FileMode.Create,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 4096,
                FileOptions.Asynchronous))
            {
                var document = new UiPreferencesDocument(CurrentSchemaVersion, preferences.Theme.ToString());
                await JsonSerializer.SerializeAsync(
                    stream,
                    document,
                    UiPreferencesJsonContext.Default.UiPreferencesDocument,
                    cancellationToken);
                await stream.FlushAsync(cancellationToken);
            }
            File.Move(temporaryPath, _path, overwrite: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            TryDelete(temporaryPath);
            throw new AmiraException(new(
                AmiraErrorCodes.UiPreferencesSaveFailed,
                ErrorCategory.Persistence,
                "The interface settings could not be saved.",
                true));
        }
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
    }

    private static AmiraException InvalidPath() => new(new(
        AmiraErrorCodes.ClientPathInvalid,
        ErrorCategory.Configuration,
        "The interface settings path is invalid."));

    private static AmiraException InvalidPreferences() => new(new(
        AmiraErrorCodes.UiPreferencesInvalid,
        ErrorCategory.Configuration,
        "The saved interface settings are invalid."));
}

public static class ThemePreferencePolicy
{
    public static ElementTheme RequestedTheme(AppThemePreference preference) => preference switch
    {
        AppThemePreference.System => ElementTheme.Default,
        AppThemePreference.Light => ElementTheme.Light,
        AppThemePreference.Dark => ElementTheme.Dark,
        _ => throw new ArgumentOutOfRangeException(nameof(preference), preference, "Unsupported theme preference."),
    };

    public static AppThemePreference QuickToggle(ElementTheme actualTheme) => actualTheme switch
    {
        ElementTheme.Dark => AppThemePreference.Light,
        ElementTheme.Light => AppThemePreference.Dark,
        _ => throw new ArgumentOutOfRangeException(nameof(actualTheme), actualTheme, "Quick theme toggling requires an explicit actual theme."),
    };

    public static int SelectionIndex(AppThemePreference preference) => preference switch
    {
        AppThemePreference.System => 0,
        AppThemePreference.Light => 1,
        AppThemePreference.Dark => 2,
        _ => throw new ArgumentOutOfRangeException(nameof(preference), preference, "Unsupported theme preference."),
    };

    public static AppThemePreference FromSelectionIndex(int index) => index switch
    {
        0 => AppThemePreference.System,
        1 => AppThemePreference.Light,
        2 => AppThemePreference.Dark,
        _ => throw new ArgumentOutOfRangeException(nameof(index), index, "Unsupported theme selection."),
    };
}

internal sealed record UiPreferencesDocument(int SchemaVersion, string Theme);

[JsonSerializable(typeof(UiPreferencesDocument))]
internal sealed partial class UiPreferencesJsonContext : JsonSerializerContext
{
}
