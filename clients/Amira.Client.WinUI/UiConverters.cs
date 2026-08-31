using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Amira.Domain;
using System.Globalization;

namespace Amira.Client.WinUI;

public sealed class UserNoticeSeverityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value switch
    {
        UserNoticeSeverity.Success => InfoBarSeverity.Success,
        UserNoticeSeverity.Error => InfoBarSeverity.Error,
        _ => InfoBarSeverity.Informational,
    };

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class UserNoticeLiveSettingConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value switch
    {
        UserNoticeSeverity.Success => AutomationLiveSetting.Polite,
        UserNoticeSeverity.Error => AutomationLiveSetting.Assertive,
        _ => AutomationLiveSetting.Off,
    };

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class NullToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        bool visible = value is not null;
        if (parameter is "Invert") visible = !visible;
        return visible ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class EnumValueToVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) =>
        parameter is string expected && string.Equals(value?.ToString(), expected, StringComparison.Ordinal)
            ? Visibility.Visible
            : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class LocalTimeConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is DateTimeOffset timestamp
        ? timestamp.ToLocalTime().ToString("t", CultureInfo.CurrentCulture)
        : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnActionVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is Amira.Contracts.TurnView turn && parameter is string action &&
        ((action == "stop" && TurnActivityPolicy.CanStop(turn)) ||
         (action == "retry" && TurnActivityPolicy.CanRetry(turn)))
            ? Visibility.Visible
            : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnActionAreaVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is Amira.Contracts.TurnView turn && TurnActivityPolicy.HasAnyAction(turn)
        ? Visibility.Visible
        : Visibility.Collapsed;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnIdShortConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        string identifier = value?.ToString() ?? string.Empty;
        return identifier.Length > 8 ? identifier[..8] : identifier;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnStatusTextConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is Amira.Contracts.TurnView turn
        ? turn.StopRequested ? "Stop requested" : turn.Status.ToString()
        : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnStatusBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        Windows.UI.Color color = value is Amira.Contracts.TurnView { StopRequested: true }
            ? Windows.UI.Color.FromArgb(255, 214, 151, 45)
            : value is Amira.Contracts.TurnView { Status: BotTurnStatus.Running }
                ? Windows.UI.Color.FromArgb(255, 77, 145, 255)
                : value is Amira.Contracts.TurnView { Status: BotTurnStatus.Completed }
                    ? Windows.UI.Color.FromArgb(255, 88, 213, 135)
                    : value is Amira.Contracts.TurnView { Status: BotTurnStatus.Failed }
                        ? Windows.UI.Color.FromArgb(255, 239, 92, 92)
                        : Windows.UI.Color.FromArgb(255, 150, 156, 168);
        return new Microsoft.UI.Xaml.Media.SolidColorBrush(color);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnStatusIconVisibilityConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        if (value is not Amira.Contracts.TurnView turn || parameter is not string icon) return Visibility.Collapsed;
        bool visible = icon switch
        {
            "StopRequested" => turn.StopRequested,
            "Queued" => !turn.StopRequested && turn.Status is BotTurnStatus.Queued,
            "Running" => !turn.StopRequested && turn.Status is BotTurnStatus.Running,
            "Completed" => !turn.StopRequested && turn.Status is BotTurnStatus.Completed,
            "Failed" => !turn.StopRequested && turn.Status is BotTurnStatus.Failed,
            "Cancelled" => !turn.StopRequested && turn.Status is BotTurnStatus.Cancelled,
            _ => false
        };
        return visible ? Visibility.Visible : Visibility.Collapsed;
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnActivityTimeLabelConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is Amira.Contracts.TurnView turn
        ? turn.Status switch
        {
            BotTurnStatus.Queued => "Queued",
            BotTurnStatus.Running => "Started",
            _ => "Finished"
        }
        : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnActivityTimeConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        if (value is not Amira.Contracts.TurnView turn) return string.Empty;
        DateTimeOffset timestamp = turn.Status switch
        {
            BotTurnStatus.Queued => turn.QueuedAt,
            BotTurnStatus.Running => turn.StartedAt ?? turn.QueuedAt,
            _ => turn.FinishedAt ?? turn.StartedAt ?? turn.QueuedAt
        };
        return timestamp.ToLocalTime().ToString("t", CultureInfo.CurrentCulture);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class ProviderProtocolTextConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is ProviderProtocol protocol
        ? ConnectionDialogDisplayPolicy.ProtocolLabel(protocol)
        : string.Empty;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnFailureDetailConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => parameter switch
    {
        "category" => value is Amira.Errors.AmiraError failure ? failure.Category.ToString() : string.Empty,
        "code" => value is Amira.Errors.AmiraError failure ? failure.Code : string.Empty,
        _ => throw new ArgumentOutOfRangeException(nameof(parameter), parameter, "Failure detail parameters must be category or code.")
    };

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnUsageTotalConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is TurnUsage usage
        ? TokenCountFormatter.Format(usage.TotalTokens, CultureInfo.CurrentCulture)
        : TokenCountFormatter.Unavailable;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnUsageTokenConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language)
    {
        TurnUsage? usage = value as TurnUsage;
        int? tokenCount = parameter switch
        {
            "input" => usage?.InputTokens,
            "output" => usage?.OutputTokens,
            _ => throw new ArgumentOutOfRangeException(nameof(parameter), parameter, "Token usage parameters must be input or output.")
        };
        return TokenCountFormatter.Format(tokenCount, CultureInfo.CurrentCulture);
    }

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class TurnDurationConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, string language) => value is TimeSpan duration
        ? TurnDurationFormatter.Format(duration, CultureInfo.CurrentCulture)
        : TurnDurationFormatter.Unavailable;

    public object ConvertBack(object value, Type targetType, object parameter, string language) => throw new NotSupportedException();
}

public sealed class ChatMessageTemplateSelector : DataTemplateSelector
{
    public DataTemplate? HumanTemplate { get; set; }
    public DataTemplate? BotTemplate { get; set; }
    public DataTemplate? LongBotTemplate { get; set; }

    protected override DataTemplate SelectTemplateCore(object item) => item is ChatMessage { Author: MessageAuthor.Human }
        ? HumanTemplate!
        : item is ChatMessage { Revision.Content.Length: > 220 }
            ? LongBotTemplate!
            : BotTemplate!;

    protected override DataTemplate SelectTemplateCore(object item, DependencyObject container) => SelectTemplateCore(item);
}
