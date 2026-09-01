using Amira.Domain;

namespace Amira.Client.WinUI.Tests;

public sealed class TimelineGroupingPolicyTests
{
    private static readonly DateTimeOffset Today = CreateLocalTime(2026, 8, 31, 12);

    [Fact]
    public void Empty_timeline_produces_no_groups()
    {
        Assert.Empty(TimelineGroupingPolicy.GroupByDay([], Today));
    }

    [Fact]
    public void Messages_on_the_same_day_share_one_group_in_order()
    {
        DateTimeOffset today = Today;
        ChatMessage first = CreateMessage(today.Date.AddHours(9));
        ChatMessage second = CreateMessage(today.Date.AddHours(17));

        IReadOnlyList<TimelineDayGroup> groups = TimelineGroupingPolicy.GroupByDay([first, second], today);

        TimelineDayGroup group = Assert.Single(groups);
        Assert.Equal("Today", group.Label);
        Assert.Equal([first, second], group);
    }

    [Fact]
    public void Yesterday_and_today_get_friendly_labels()
    {
        DateTimeOffset today = Today;
        ChatMessage old = CreateMessage(today.AddDays(-1).Date.AddHours(12));
        ChatMessage recent = CreateMessage(today.Date.AddHours(12));

        IReadOnlyList<TimelineDayGroup> groups = TimelineGroupingPolicy.GroupByDay([old, recent], today);

        Assert.Equal(["Yesterday", "Today"], groups.Select(group => group.Label).ToArray());
    }

    [Fact]
    public void Dates_from_another_year_include_the_year()
    {
        DateTimeOffset today = Today;
        DateTimeOffset lastYear = today.AddYears(-1);

        IReadOnlyList<TimelineDayGroup> groups = TimelineGroupingPolicy.GroupByDay([CreateMessage(lastYear)], today);

        TimelineDayGroup group = Assert.Single(groups);
        Assert.Contains(lastYear.Year.ToString(), group.Label);
    }

    private static ChatMessage CreateMessage(DateTimeOffset createdAt)
    {
        MessageId messageId = MessageId.New();
        MessageRevision revision = MessageRevision.Create(messageId, "content");
        return new ChatMessage(
            messageId,
            DirectChatId.New(),
            MessageAuthor.Bot,
            revision,
            createdAt,
            MessageStatus.Committed);
    }

    private static DateTimeOffset CreateLocalTime(int year, int month, int day, int hour)
    {
        DateTime local = new(year, month, day, hour, 0, 0, DateTimeKind.Unspecified);
        return new DateTimeOffset(local, TimeZoneInfo.Local.GetUtcOffset(local));
    }
}
