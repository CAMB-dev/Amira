using System.Diagnostics;
using System.Diagnostics.Metrics;
using Amira.Contracts;
using Amira.Domain;
using Microsoft.Extensions.Logging;

namespace Amira.Runtime;

internal static class RuntimeTelemetry
{
    public static readonly ActivitySource Activities = new(AmiraTelemetry.ActivitySourceName);
    public static readonly Meter Meter = new("Amira.Runtime");
    public static readonly Counter<long> RequestSuccess = Meter.CreateCounter<long>("amira.chat.request.success");
    public static readonly Counter<long> RequestFailure = Meter.CreateCounter<long>("amira.chat.request.failure");
    public static readonly Counter<long> RequestCancellation = Meter.CreateCounter<long>("amira.chat.request.cancel");
    public static readonly Histogram<double> RequestDuration = Meter.CreateHistogram<double>("amira.chat.request.duration", "ms");
    public static readonly Histogram<double> TimeToFirstToken = Meter.CreateHistogram<double>("amira.chat.request.ttft", "ms");
    public static readonly Counter<long> InputTokens = Meter.CreateCounter<long>("amira.chat.usage.input_tokens");
    public static readonly Counter<long> OutputTokens = Meter.CreateCounter<long>("amira.chat.usage.output_tokens");

    public static KeyValuePair<string, object?>[] ActivityTags(BotTurn turn) =>
    [
        new(AmiraTelemetry.Tags.BotId, turn.BotId.Value),
        new(AmiraTelemetry.Tags.ChatId, turn.ChatId.Value),
        new(AmiraTelemetry.Tags.TurnId, turn.Id.Value),
        new(AmiraTelemetry.Tags.ProviderProtocol, turn.ModelProfileSnapshot.Protocol.ToString()),
        new(AmiraTelemetry.Tags.Model, turn.ModelProfileSnapshot.Model)
    ];

    public static KeyValuePair<string, object?>[] MetricTags(BotTurn turn, string outcome) =>
    [
        new(AmiraTelemetry.Tags.ProviderProtocol, turn.ModelProfileSnapshot.Protocol.ToString()),
        new("outcome", outcome)
    ];
}

internal static partial class RuntimeLog
{
    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnClaimed, Level = LogLevel.Debug, Message = "Turn {TurnId} claimed for bot {BotId}.")]
    public static partial void TurnClaimed(ILogger logger, string turnId, string botId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.MessageCommitted, Level = LogLevel.Debug, Message = "Human message committed for bot {BotId}.")]
    public static partial void MessageCommitted(ILogger logger, string botId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnQueued, Level = LogLevel.Debug, Message = "Turn {TurnId} queued for bot {BotId}.")]
    public static partial void TurnQueued(ILogger logger, string turnId, string botId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnCompleted, Level = LogLevel.Debug, Message = "Turn {TurnId} completed for bot {BotId}.")]
    public static partial void TurnCompleted(ILogger logger, string turnId, string botId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnFailed, Level = LogLevel.Debug, Message = "Turn {TurnId} failed for bot {BotId} with error code {ErrorCode}.")]
    public static partial void TurnFailed(ILogger logger, string turnId, string botId, string errorCode);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnCancelled, Level = LogLevel.Debug, Message = "Turn {TurnId} cancelled for bot {BotId}.")]
    public static partial void TurnCancelled(ILogger logger, string turnId, string botId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestStarted, Level = LogLevel.Information, Message = "Provider request started for turn {TurnId}, bot {BotId}, protocol {Protocol}, model {Model}.")]
    public static partial void RequestStarted(ILogger logger, string turnId, string botId, string protocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCompleted, Level = LogLevel.Information, Message = "Provider request completed for turn {TurnId} in {DurationMs} ms.")]
    public static partial void RequestCompleted(ILogger logger, string turnId, double durationMs);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestFailed, Level = LogLevel.Warning, Message = "Provider request failed for turn {TurnId} with error code {ErrorCode}.")]
    public static partial void RequestFailed(ILogger logger, string turnId, string errorCode);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCancelled, Level = LogLevel.Information, Message = "Provider request cancelled for turn {TurnId}.")]
    public static partial void RequestCancelled(ILogger logger, string turnId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ContextBuilt, Level = LogLevel.Debug, Message = "Context built for turn {TurnId}: included {IncludedMessages}, dropped {DroppedMessages}, characters {Characters}.")]
    public static partial void ContextBuilt(ILogger logger, string turnId, int includedMessages, int droppedMessages, int characters);
}
