using System.Globalization;
using Amira.Client.WinUI;

namespace Amira.Client.WinUI.Tests;

public sealed class TurnDurationFormatterTests
{
    [Fact]
    public void Format_returns_an_em_dash_when_timing_is_unavailable()
    {
        Assert.Equal("—", TurnDurationFormatter.Format(null, CultureInfo.GetCultureInfo("en-US")));
    }

    [Theory]
    [InlineData(0, "<1 ms")]
    [InlineData(1, "1 ms")]
    [InlineData(999, "999 ms")]
    [InlineData(1_500, "1.5 s")]
    [InlineData(90_000, "1.5 m")]
    public void Format_uses_compact_units(double milliseconds, string expected)
    {
        Assert.Equal(expected, TurnDurationFormatter.Format(TimeSpan.FromMilliseconds(milliseconds), CultureInfo.GetCultureInfo("en-US")));
    }

    [Fact]
    public void Format_uses_the_supplied_current_culture()
    {
        Assert.Equal("1,5 s", TurnDurationFormatter.Format(TimeSpan.FromMilliseconds(1_500), CultureInfo.GetCultureInfo("de-DE")));
    }

    [Fact]
    public void Usage_token_converter_preserves_missing_usage_but_rejects_an_unknown_parameter()
    {
        TurnUsageTokenConverter converter = new();

        Assert.Equal("—", converter.Convert(null!, typeof(string), "input", string.Empty));
        Assert.Throws<ArgumentOutOfRangeException>(() => converter.Convert(null!, typeof(string), "total", string.Empty));
    }
}
