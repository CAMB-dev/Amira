using System.Globalization;

namespace Amira.Client.WinUI;

public static class TurnDurationFormatter
{
    public const string Unavailable = "—";

    public static string Format(TimeSpan? duration, CultureInfo culture) => duration is { } value
        ? Format(value, culture)
        : Unavailable;

    public static string Format(TimeSpan duration, CultureInfo culture)
    {
        double milliseconds = duration.TotalMilliseconds;
        if (milliseconds < 1) return "<1 ms";
        if (milliseconds < 1_000) return $"{milliseconds.ToString("0", culture)} ms";
        if (duration.TotalSeconds < 60) return $"{duration.TotalSeconds.ToString("0.0", culture)} s";
        return $"{duration.TotalMinutes.ToString("0.0", culture)} m";
    }
}

public static class TokenCountFormatter
{
    public const string Unavailable = "—";

    public static string Format(int? tokenCount, CultureInfo culture) => tokenCount?.ToString("N0", culture) ?? Unavailable;
}
