using System.Globalization;
using System.Windows.Data;
using Amira.Domain;

namespace Amira.Client.Wpf;

public sealed class TurnActionEnabledConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture) =>
        value is BotTurnStatus status && parameter is string action && action switch
        {
            "stop" => status is BotTurnStatus.Queued or BotTurnStatus.Running,
            "retry" => status is BotTurnStatus.Failed or BotTurnStatus.Cancelled,
            _ => false
        };
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => throw new NotSupportedException();
}
