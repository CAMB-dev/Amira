using Amira.Client.WinUI;
using Microsoft.UI.Xaml;

namespace Amira.Client.WinUI.Tests;

public sealed class ThemeButtonTextPolicyTests
{
    [Fact]
    public void Dark_theme_describes_the_switch_to_light_appearance()
    {
        RecordingStringProvider strings = new();

        ThemeButtonText text = ThemeButtonTextPolicy.For(ElementTheme.Dark, strings);

        Assert.Equal(UiStringKeys.ThemeSwitchToLight, strings.LastKey);
        Assert.Equal("Switch to light appearance", text.ToolTip);
        Assert.Equal("\uE706", text.Glyph);
    }

    [Fact]
    public void Light_theme_describes_the_switch_to_dark_appearance()
    {
        RecordingStringProvider strings = new();

        ThemeButtonText text = ThemeButtonTextPolicy.For(ElementTheme.Light, strings);

        Assert.Equal(UiStringKeys.ThemeSwitchToDark, strings.LastKey);
        Assert.Equal("Switch to dark appearance", text.ToolTip);
        Assert.Equal("\uE708", text.Glyph);
    }

    private sealed class RecordingStringProvider : IUiStringProvider
    {
        public string? LastKey { get; private set; }

        public string GetString(string key)
        {
            LastKey = key;
            return key switch
            {
                UiStringKeys.ThemeSwitchToLight => "Switch to light appearance",
                UiStringKeys.ThemeSwitchToDark => "Switch to dark appearance",
                _ => throw new ArgumentOutOfRangeException(nameof(key), key, "Unexpected UI resource key.")
            };
        }
    }
}
