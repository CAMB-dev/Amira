using System.Diagnostics;
using System.Diagnostics.Metrics;
using Amira.Contracts;
using Amira.Domain;
using Microsoft.Extensions.Logging;

namespace Amira.Runtime;

internal sealed class RuntimeTelemetry
{
    private readonly Instruments? _instruments;

    public RuntimeTelemetry(IMeterFactory? meterFactory)
    {
        if (meterFactory is null) return;

        Meter meter = meterFactory.Create(new MeterOptions(AmiraTelemetry.MeterName)
        {
            Version = AmiraTelemetry.InstrumentationVersion
        });
        _instruments = new Instruments(
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.ProviderRequestCount,
                "{request}",
                "Provider requests by terminal outcome."),
            meter.CreateHistogram<double>(
                AmiraTelemetry.Metrics.ProviderRequestDuration,
                "s",
                "Provider request duration."),
            meter.CreateHistogram<double>(
                AmiraTelemetry.Metrics.ProviderTimeToFirstToken,
                "s",
                "Time from provider request start to the first text delta."),
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.ProviderInputTokens,
                "{token}",
                "Provider-reported input tokens."),
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.ProviderOutputTokens,
                "{token}",
                "Provider-reported output tokens."));
    }

    public static RuntimeTelemetryScope StartMessageCommit(Bot bot, ActivityContext ambientParent)
    {
        Activity? activity = StartActivity(AmiraTelemetry.MessageCommitActivity, ActivityKind.Internal, ambientParent);
        activity?
            .SetTag(AmiraTelemetry.Tags.BotId, bot.Id.Value)
            .SetTag(AmiraTelemetry.Tags.ChatId, bot.DirectChatId.Value);
        return new RuntimeTelemetryScope(activity, ambientParent);
    }

    public static RuntimeTelemetryScope StartTurnExecution(BotTurn turn, ActivityContext parentActivityContext, ILogger logger)
    {
        Activity? activity = StartActivity(AmiraTelemetry.TurnExecuteActivity, ActivityKind.Internal, parentActivityContext);
        SetTurnTags(activity, turn);
        return new RuntimeTelemetryScope(activity, parentActivityContext, turn, logger);
    }

    public RuntimeTelemetryScope StartProviderRequest(BotTurn turn, ActivityContext durableParent, ILogger logger)
    {
        ActivityContext parent = Activity.Current?.Context ?? durableParent;
        Activity? activity = StartActivity(AmiraTelemetry.ProviderRequestActivity, ActivityKind.Client, parent);
        SetTurnTags(activity, turn);
        RuntimeLog.RequestStarted(logger, turn.Id.Value, turn.BotId.Value, turn.ModelProfileSnapshot.Protocol.ToString());
        return new RuntimeTelemetryScope(activity, parent, this, turn, logger);
    }

    internal void RecordProviderRequest(
        BotTurn turn,
        string outcome,
        TimeSpan duration,
        TimeSpan? timeToFirstToken,
        ProviderUsage? usage)
    {
        Instruments? instruments = _instruments;
        if (instruments is null) return;

        var protocolTag = new KeyValuePair<string, object?>(
            AmiraTelemetry.Tags.ProviderProtocol,
            turn.ModelProfileSnapshot.Protocol.ToString());
        var outcomeTag = new KeyValuePair<string, object?>(AmiraTelemetry.Tags.Outcome, outcome);

        instruments.ProviderRequests.Add(1, protocolTag, outcomeTag);
        instruments.RequestDuration.Record(duration.TotalSeconds, protocolTag, outcomeTag);
        if (timeToFirstToken is { } ttft)
            instruments.TimeToFirstToken.Record(ttft.TotalSeconds, protocolTag, outcomeTag);
        if (usage?.InputTokens is { } inputTokens)
            instruments.InputTokens.Add(inputTokens, protocolTag, outcomeTag);
        if (usage?.OutputTokens is { } outputTokens)
            instruments.OutputTokens.Add(outputTokens, protocolTag, outcomeTag);
    }

    private static Activity? StartActivity(string name, ActivityKind kind, ActivityContext parentActivityContext) =>
        parentActivityContext.TraceId == default
            ? AmiraTelemetry.Source.StartActivity(name, kind)
            : AmiraTelemetry.Source.StartActivity(name, kind, parentActivityContext);

    private static void SetTurnTags(Activity? activity, BotTurn turn)
    {
        activity?
            .SetTag(AmiraTelemetry.Tags.BotId, turn.BotId.Value)
            .SetTag(AmiraTelemetry.Tags.ChatId, turn.ChatId.Value)
            .SetTag(AmiraTelemetry.Tags.TurnId, turn.Id.Value)
            .SetTag(AmiraTelemetry.Tags.ProviderProtocol, turn.ModelProfileSnapshot.Protocol.ToString())
            .SetTag(AmiraTelemetry.Tags.Model, turn.ModelProfileSnapshot.Model);
    }

    private sealed record Instruments(
        Counter<long> ProviderRequests,
        Histogram<double> RequestDuration,
        Histogram<double> TimeToFirstToken,
        Counter<long> InputTokens,
        Counter<long> OutputTokens);
}

internal sealed class RuntimeTelemetryScope : IDisposable
{
    private Activity? _activity;
    private readonly ActivityContext _fallbackContext;
    private readonly RuntimeTelemetry? _telemetry;
    private readonly BotTurn? _turn;
    private readonly ILogger? _logger;
    private readonly ScopeKind _kind;
    private readonly Stopwatch? _clock;
    private TimeSpan? _timeToFirstToken;
    private ProviderUsage? _usage;
    private bool _completed;

    public RuntimeTelemetryScope(Activity? activity, ActivityContext fallbackContext)
    {
        _activity = activity;
        _fallbackContext = fallbackContext;
        _kind = ScopeKind.Activity;
    }

    public RuntimeTelemetryScope(Activity? activity, ActivityContext fallbackContext, BotTurn turn, ILogger logger)
        : this(activity, fallbackContext)
    {
        _turn = turn;
        _logger = logger;
        _kind = ScopeKind.Turn;
    }

    public RuntimeTelemetryScope(
        Activity? activity,
        ActivityContext fallbackContext,
        RuntimeTelemetry telemetry,
        BotTurn turn,
        ILogger logger)
        : this(activity, fallbackContext, turn, logger)
    {
        _telemetry = telemetry;
        _kind = ScopeKind.Provider;
        _clock = Stopwatch.StartNew();
    }

    public ActivityContext Context => _activity?.Context ?? _fallbackContext;

    public void FirstToken() => _timeToFirstToken ??= _clock!.Elapsed;

    public void Usage(ProviderUsage usage) => _usage = usage;

    public void Success() => Complete(AmiraTelemetry.Outcomes.Success);

    public void Failure(string errorCode) => Complete(AmiraTelemetry.Outcomes.Failure, errorCode);

    public void Cancelled(string errorCode = AmiraTelemetry.ErrorCodes.OperationCancelled) =>
        Complete(AmiraTelemetry.Outcomes.Cancelled, errorCode);

    public void Dispose() => Cancelled();

    private void Complete(string outcome, string? errorCode = null)
    {
        if (_completed) return;
        _completed = true;

        _clock?.Stop();
        if (_kind == ScopeKind.Provider)
            _telemetry!.RecordProviderRequest(_turn!, outcome, _clock!.Elapsed, _timeToFirstToken, _usage);

        _activity?.SetTag(AmiraTelemetry.Tags.Outcome, outcome);
        if (errorCode is not null) _activity?.SetTag(AmiraTelemetry.Tags.ErrorCode, errorCode);
        _activity?.SetStatus(outcome == AmiraTelemetry.Outcomes.Success
            ? ActivityStatusCode.Ok
            : ActivityStatusCode.Error);

        if (_kind == ScopeKind.Provider)
            LogProviderCompletion(_logger!, _turn!, _clock!.Elapsed, outcome, errorCode);
        else if (_kind == ScopeKind.Turn)
            LogTurnCompletion(_logger!, _turn!, outcome, errorCode);

        _activity?.Dispose();
        _activity = null;
    }

    private static void LogProviderCompletion(
        ILogger logger,
        BotTurn turn,
        TimeSpan duration,
        string outcome,
        string? errorCode)
    {
        if (outcome == AmiraTelemetry.Outcomes.Success)
            RuntimeLog.RequestCompleted(logger, turn.Id.Value, duration.TotalMilliseconds);
        else if (outcome == AmiraTelemetry.Outcomes.Cancelled)
            RuntimeLog.RequestCancelled(logger, turn.Id.Value);
        else
            RuntimeLog.RequestFailed(logger, turn.Id.Value, errorCode!);
    }

    private static void LogTurnCompletion(ILogger logger, BotTurn turn, string outcome, string? errorCode)
    {
        if (outcome == AmiraTelemetry.Outcomes.Success)
            RuntimeLog.TurnCompleted(logger, turn.Id.Value, turn.BotId.Value);
        else if (outcome == AmiraTelemetry.Outcomes.Cancelled)
            RuntimeLog.TurnCancelled(logger, turn.Id.Value, turn.BotId.Value);
        else
            RuntimeLog.TurnFailed(logger, turn.Id.Value, turn.BotId.Value, errorCode!);
    }

    private enum ScopeKind { Activity, Turn, Provider }
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

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestStarted, Level = LogLevel.Information, Message = "Provider request started for turn {TurnId}, bot {BotId}, protocol {Protocol}.")]
    public static partial void RequestStarted(ILogger logger, string turnId, string botId, string protocol);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCompleted, Level = LogLevel.Information, Message = "Provider request completed for turn {TurnId} in {DurationMs} ms.")]
    public static partial void RequestCompleted(ILogger logger, string turnId, double durationMs);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestFailed, Level = LogLevel.Warning, Message = "Provider request failed for turn {TurnId} with error code {ErrorCode}.")]
    public static partial void RequestFailed(ILogger logger, string turnId, string errorCode);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCancelled, Level = LogLevel.Information, Message = "Provider request cancelled for turn {TurnId}.")]
    public static partial void RequestCancelled(ILogger logger, string turnId);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ContextBuilt, Level = LogLevel.Debug, Message = "Context built for turn {TurnId}: included {IncludedMessages}, dropped {DroppedMessages}, characters {Characters}.")]
    public static partial void ContextBuilt(ILogger logger, string turnId, int includedMessages, int droppedMessages, int characters);
}
