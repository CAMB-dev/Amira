using Microsoft.UI.Xaml;
using Microsoft.Windows.ApplicationModel.Resources;

namespace Amira.Client.WinUI;

public interface IUiStringProvider
{
    string GetString(string key);
}

public sealed class MrtCoreUiStringProvider : IUiStringProvider
{
    private readonly ResourceLoader _loader = new(ResourceLoader.GetDefaultResourceFilePath(), "Resources");

    public string GetString(string key) => _loader.GetString(key);
}

public static class UiStringKeys
{
    public const string ThemeSwitchToLight = "ThemeSwitchToLight";
    public const string ThemeSwitchToDark = "ThemeSwitchToDark";
}

public readonly record struct ThemeButtonText(string Glyph, string ToolTip);

public static class ThemeButtonTextPolicy
{
    public static ThemeButtonText For(ElementTheme theme, IUiStringProvider strings) => theme switch
    {
        ElementTheme.Dark => new("\uE706", strings.GetString(UiStringKeys.ThemeSwitchToLight)),
        ElementTheme.Light => new("\uE708", strings.GetString(UiStringKeys.ThemeSwitchToDark)),
        _ => throw new ArgumentOutOfRangeException(nameof(theme), theme, "Theme button text requires an explicit light or dark theme.")
    };
}
