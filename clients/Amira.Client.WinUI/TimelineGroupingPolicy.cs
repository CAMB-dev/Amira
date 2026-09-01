using System.Collections;
using System.Globalization;
using Amira.Domain;

namespace Amira.Client.WinUI;

/// <summary>One calendar day's worth of Direct chat messages for grouped conversation display.</summary>
public sealed class TimelineDayGroup(string label, IReadOnlyList<ChatMessage> messages) : IReadOnlyList<ChatMessage>
{
    public string Label { get; } = label;
    public int Count => messages.Count;
    public ChatMessage this[int index] => messages[index];
    public IEnumerator<ChatMessage> GetEnumerator() => messages.GetEnumerator();
    IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
}

/// <summary>Buckets an ordered timeline into consecutive calendar-day groups with friendly labels.</summary>
public static class TimelineGroupingPolicy
{
    public static IReadOnlyList<TimelineDayGroup> GroupByDay(IReadOnlyList<ChatMessage> messages, DateTimeOffset? today = null)
    {
        ArgumentNullException.ThrowIfNull(messages);
        DateOnly currentDay = DateOnly.FromDateTime((today ?? DateTimeOffset.Now).ToLocalTime().DateTime);
        List<TimelineDayGroup> groups = [];
        List<ChatMessage>? bucket = null;
        DateOnly bucketDay = default;
        foreach (ChatMessage message in messages)
        {
            DateOnly day = DateOnly.FromDateTime(message.CreatedAt.ToLocalTime().DateTime);
            if (bucket is null || day != bucketDay)
            {
                if (bucket is not null) groups.Add(new TimelineDayGroup(FormatLabel(bucketDay, currentDay), bucket));
                bucket = [];
                bucketDay = day;
            }
            bucket.Add(message);
        }
        if (bucket is not null) groups.Add(new TimelineDayGroup(FormatLabel(bucketDay, currentDay), bucket));
        return groups;
    }

    internal static string FormatLabel(DateOnly day, DateOnly today)
    {
        if (day == today) return "Today";
        if (day == today.AddDays(-1)) return "Yesterday";
        string pattern = day.Year == today.Year ? "MMMM d" : "MMMM d, yyyy";
        return day.ToString(pattern, CultureInfo.CurrentCulture);
    }
}
