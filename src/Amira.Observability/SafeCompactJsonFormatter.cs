using System.Diagnostics;
using Serilog.Events;
using Serilog.Formatting;
using Serilog.Formatting.Compact;

namespace Amira.Observability;

internal sealed class SafeCompactJsonFormatter : ITextFormatter
{
    private static readonly string[] SensitiveKeyFragments =
    [
        "apikey",
        "auth",
        "body",
        "content",
        "credential",
        "exception",
        "header",
        "message",
        "password",
        "prompt",
        "requestbody",
        "response",
        "secret",
        "stack",
        "token",
    ];

    private readonly CompactJsonFormatter _formatter = new();

    public void Format(LogEvent logEvent, TextWriter output)
    {
        ArgumentNullException.ThrowIfNull(logEvent);
        ArgumentNullException.ThrowIfNull(output);

        List<LogEventProperty> properties = SanitizeProperties(logEvent.Properties);
        properties.Add(new LogEventProperty("level", new ScalarValue(logEvent.Level.ToString())));
        AddEventIdentity(properties, logEvent.Properties);

        var safeEvent = new LogEvent(
            logEvent.Timestamp.ToUniversalTime(),
            logEvent.Level,
            exception: null,
            logEvent.MessageTemplate,
            properties,
            logEvent.TraceId ?? default(ActivityTraceId),
            logEvent.SpanId ?? default(ActivitySpanId));
        _formatter.Format(safeEvent, output);
    }

    private static List<LogEventProperty> SanitizeProperties(
        IReadOnlyDictionary<string, LogEventPropertyValue> properties)
    {
        var sanitized = new List<LogEventProperty>(properties.Count + 3);
        foreach ((string name, LogEventPropertyValue value) in properties)
        {
            if (!IsSensitive(name))
            {
                sanitized.Add(new LogEventProperty(name, SanitizeValue(value)));
            }
        }

        return sanitized;
    }

    private static LogEventPropertyValue SanitizeValue(LogEventPropertyValue value) => value switch
    {
        ScalarValue { Value: Exception } => new ScalarValue("exception_redacted"),
        SequenceValue sequence => new SequenceValue(sequence.Elements.Select(SanitizeValue)),
        StructureValue structure => new StructureValue(
            structure.Properties
                .Where(property => !IsSensitive(property.Name))
                .Select(property => new LogEventProperty(property.Name, SanitizeValue(property.Value))),
            structure.TypeTag),
        DictionaryValue dictionary => new DictionaryValue(
            dictionary.Elements
                .Where(entry => entry.Key.Value is not string key || !IsSensitive(key))
                .Select(entry => new KeyValuePair<ScalarValue, LogEventPropertyValue>(
                    entry.Key,
                    SanitizeValue(entry.Value)))),
        _ => value,
    };

    private static void AddEventIdentity(
        ICollection<LogEventProperty> target,
        IReadOnlyDictionary<string, LogEventPropertyValue> source)
    {
        if (!source.TryGetValue("EventId", out LogEventPropertyValue? eventIdentity)
            || eventIdentity is not StructureValue structure)
        {
            return;
        }

        foreach (LogEventProperty property in structure.Properties)
        {
            if (property is { Name: "Id", Value: ScalarValue id })
            {
                target.Add(new LogEventProperty("event_id", id));
            }
            else if (property is { Name: "Name", Value: ScalarValue name })
            {
                target.Add(new LogEventProperty("event_name", name));
            }
        }
    }

    private static bool IsSensitive(string key)
    {
        string normalized = string.Concat(key.Where(char.IsLetterOrDigit)).ToLowerInvariant();
        return SensitiveKeyFragments.Any(normalized.Contains);
    }
}
