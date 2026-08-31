using Amira.Client.WinUI;
using Amira.Errors;
using Microsoft.UI.Xaml;

namespace Amira.Client.WinUI.Tests;

public sealed class UiPreferencesTests
{
    [Fact]
    public async Task Missing_file_uses_the_existing_dark_default()
    {
        string directory = CreateDirectory();
        try
        {
            var store = new JsonUiPreferencesStore(Path.Combine(directory, "ui-preferences.json"));

            UiPreferences preferences = await store.LoadAsync(TestContext.Current.CancellationToken);

            Assert.Equal(AppThemePreference.Dark, preferences.Theme);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData(AppThemePreference.System)]
    [InlineData(AppThemePreference.Light)]
    [InlineData(AppThemePreference.Dark)]
    public async Task Theme_preference_round_trips(AppThemePreference theme)
    {
        string directory = CreateDirectory();
        try
        {
            var store = new JsonUiPreferencesStore(Path.Combine(directory, "ui-preferences.json"));

            await store.SaveAsync(new UiPreferences(theme), TestContext.Current.CancellationToken);
            UiPreferences restored = await store.LoadAsync(TestContext.Current.CancellationToken);

            Assert.Equal(theme, restored.Theme);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Corrupt_preferences_are_a_configuration_error()
    {
        string directory = CreateDirectory();
        try
        {
            string path = Path.Combine(directory, "ui-preferences.json");
            await File.WriteAllTextAsync(path, "{ not-json", TestContext.Current.CancellationToken);
            var store = new JsonUiPreferencesStore(path);

            AmiraException error = await Assert.ThrowsAsync<AmiraException>(async () =>
                await store.LoadAsync(TestContext.Current.CancellationToken));

            Assert.Equal(AmiraErrorCodes.UiPreferencesInvalid, error.Code);
            Assert.Equal(ErrorCategory.Configuration, error.Error.Category);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData(AppThemePreference.System, ElementTheme.Default, 0)]
    [InlineData(AppThemePreference.Light, ElementTheme.Light, 1)]
    [InlineData(AppThemePreference.Dark, ElementTheme.Dark, 2)]
    public void Theme_policy_maps_persistence_xaml_and_selection(
        AppThemePreference preference,
        ElementTheme requestedTheme,
        int selectionIndex)
    {
        Assert.Equal(requestedTheme, ThemePreferencePolicy.RequestedTheme(preference));
        Assert.Equal(selectionIndex, ThemePreferencePolicy.SelectionIndex(preference));
        Assert.Equal(preference, ThemePreferencePolicy.FromSelectionIndex(selectionIndex));
    }

    [Fact]
    public void Quick_toggle_uses_the_actual_theme()
    {
        Assert.Equal(AppThemePreference.Light, ThemePreferencePolicy.QuickToggle(ElementTheme.Dark));
        Assert.Equal(AppThemePreference.Dark, ThemePreferencePolicy.QuickToggle(ElementTheme.Light));
    }

    private static string CreateDirectory()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"amira-ui-preferences-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        return directory;
    }
}
