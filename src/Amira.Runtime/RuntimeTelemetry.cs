using System.Diagnostics;
using System.Diagnostics.Metrics;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Microsoft.Extensions.Logging;

namespace Amira.Runtime;

internal sealed class RuntimeTelemetry
{
    private readonly Instruments? _instruments;
    private long _queuedTurns;

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
                "Provider-reported output tokens."),
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.TurnQueuedTotal,
                "{turn}",
                "New durable Turns queued by initial send or retry. This is cumulative, not current queue depth."),
            meter.CreateObservableGauge(
                AmiraTelemetry.Metrics.QueuedTurns,
                () => Volatile.Read(ref _queuedTurns),
                "{turn}",
                "Turns currently in the durable queued state."),
            meter.CreateUpDownCounter<long>(
                AmiraTelemetry.Metrics.ActiveTurns,
                "{turn}",
                "Turns currently executing in this runtime process. The value resets when the process restarts."),
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.TurnStopRequestedTotal,
                "{turn}",
                "New durable stop request transitions."),
            meter.CreateCounter<long>(
                AmiraTelemetry.Metrics.TurnCancelledTotal,
                "{turn}",
                "Turns durably transitioned to Cancelled."));
    }

    public static RuntimeTelemetryScope StartMessageCommit(Bot bot, ActivityContext ambientParent)
    {
        Activity? activity = StartActivity(AmiraTelemetry.MessageCommitActivity, ActivityKind.Internal, ambientParent);
        activity?
            .SetTag(AmiraTelemetry.Tags.BotId, bot.Id.Value)
            .SetTag(AmiraTelemetry.Tags.ChatId, bot.DirectChatId.Value);
        return new RuntimeTelemetryScope(activity, ambientParent);
    }

    public static RuntimeTelemetryScope StartMessageCommit(BotTurn turn, ActivityContext parentActivityContext)
    {
        Activity? activity = StartActivity(AmiraTelemetry.MessageCommitActivity, ActivityKind.Internal, parentActivityContext);
        SetTurnTags(activity, turn);
        return new RuntimeTelemetryScope(activity, parentActivityContext);
    }

    public static RuntimeTelemetryScope StartTurnQueue(BotTurn turn, ActivityContext parentActivityContext)
    {
        Activity? activity = StartActivity(AmiraTelemetry.TurnQueueActivity, ActivityKind.Producer, parentActivityContext);
        SetTurnTags(activity, turn);
        return new RuntimeTelemetryScope(activity, parentActivityContext);
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
        RuntimeLog.RequestStarted(
            logger,
            turn.BotId.Value,
            turn.ChatId.Value,
            turn.Id.Value,
            turn.ModelProfileSnapshot.Protocol.ToString(),
            turn.ModelProfileSnapshot.Model);
        return new RuntimeTelemetryScope(activity, parent, this, turn, logger);
    }

    public static RuntimeTelemetryScope StartProviderStream(BotTurn turn, ActivityContext parentActivityContext)
    {
        Activity? activity = StartActivity(AmiraTelemetry.ProviderStreamActivity, ActivityKind.Internal, parentActivityContext);
        SetTurnTags(activity, turn);
        return new RuntimeTelemetryScope(activity, parentActivityContext);
    }

    public void TurnQueued()
    {
        Interlocked.Increment(ref _queuedTurns);
        _instruments?.TurnsQueued.Add(1);
    }

    public void TurnClaimed() => TurnLeftQueue();

    public void TurnLeftQueue()
    {
        while (true)
        {
            long current = Volatile.Read(ref _queuedTurns);
            if (current <= 0) return;
            if (Interlocked.CompareExchange(ref _queuedTurns, current - 1, current) == current) return;
        }
    }

    public void SeedQueuedTurns(long count) => Interlocked.Exchange(ref _queuedTurns, count);

    public void TurnBecameActive() => _instruments?.ActiveTurns.Add(1);

    public void TurnBecameInactive() => _instruments?.ActiveTurns.Add(-1);

    public void StopRequested() => _instruments?.StopRequests.Add(1);

    public void TurnCancelled() => _instruments?.CancelledTurns.Add(1);

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

    internal static void SetTurnTags(Activity? activity, BotTurn turn)
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
        Counter<long> OutputTokens,
        Counter<long> TurnsQueued,
        ObservableGauge<long> QueuedTurns,
        UpDownCounter<long> ActiveTurns,
        Counter<long> StopRequests,
        Counter<long> CancelledTurns);
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

    public void AttachTurn(BotTurn turn) => RuntimeTelemetry.SetTurnTags(_activity, turn);

    public void FirstToken() => _timeToFirstToken ??= _clock!.Elapsed;

    public void Usage(ProviderUsage usage) => _usage = usage;

    public void Success() => Complete(AmiraTelemetry.Outcomes.Success);

    public void Failure(string errorCode, ErrorCategory errorCategory) =>
        Complete(AmiraTelemetry.Outcomes.Failure, errorCode, errorCategory);

    public void Cancelled(
        string errorCode = AmiraTelemetry.ErrorCodes.OperationCancelled,
        ErrorCategory errorCategory = ErrorCategory.Concurrency) =>
        Complete(AmiraTelemetry.Outcomes.Cancelled, errorCode, errorCategory);

    public void Dispose() => Cancelled();

    private void Complete(
        string outcome,
        string? errorCode = null,
        ErrorCategory? errorCategory = null)
    {
        if (_completed) return;
        _completed = true;

        _clock?.Stop();
        if (_kind == ScopeKind.Provider)
            _telemetry!.RecordProviderRequest(_turn!, outcome, _clock!.Elapsed, _timeToFirstToken, _usage);

        _activity?.SetTag(AmiraTelemetry.Tags.Outcome, outcome);
        if (errorCode is not null) _activity?.SetTag(AmiraTelemetry.Tags.ErrorCode, errorCode);
        if (errorCategory is not null)
            _activity?.SetTag(AmiraTelemetry.Tags.ErrorCategory, errorCategory.Value.ToString());
        _activity?.SetStatus(outcome == AmiraTelemetry.Outcomes.Success
            ? ActivityStatusCode.Ok
            : ActivityStatusCode.Error);

        Activity? activity = _activity;
        Activity? previous = Activity.Current;
        bool activateForLog = activity is not null && previous != activity;
        if (activateForLog) Activity.Current = activity;
        try
        {
            if (_kind == ScopeKind.Provider)
                LogProviderCompletion(_logger!, _turn!, _clock!.Elapsed, _usage, outcome, errorCode, errorCategory);
            else if (_kind == ScopeKind.Turn)
                LogTurnCompletion(_logger!, _turn!, outcome, errorCode, errorCategory);
        }
        finally
        {
            activity?.Dispose();
            _activity = null;
            if (activateForLog) Activity.Current = previous;
        }
    }

    private static void LogProviderCompletion(
        ILogger logger,
        BotTurn turn,
        TimeSpan duration,
        ProviderUsage? usage,
        string outcome,
        string? errorCode,
        ErrorCategory? errorCategory)
    {
        string botId = turn.BotId.Value;
        string chatId = turn.ChatId.Value;
        string turnId = turn.Id.Value;
        string protocol = turn.ModelProfileSnapshot.Protocol.ToString();
        string model = turn.ModelProfileSnapshot.Model;
        double durationMs = duration.TotalMilliseconds;
        int? usageInput = usage?.InputTokens;
        int? usageOutput = usage?.OutputTokens;
        string? category = errorCategory?.ToString();

        if (outcome == AmiraTelemetry.Outcomes.Success)
            RuntimeLog.RequestCompleted(
                logger, botId, chatId, turnId, protocol, model, durationMs, usageInput, usageOutput, errorCode, category);
        else if (outcome == AmiraTelemetry.Outcomes.Cancelled)
            RuntimeLog.RequestCancelled(
                logger, botId, chatId, turnId, protocol, model, durationMs, usageInput, usageOutput, errorCode, category);
        else
            RuntimeLog.RequestFailed(
                logger, botId, chatId, turnId, protocol, model, durationMs, usageInput, usageOutput, errorCode, category);
    }

    private static void LogTurnCompletion(
        ILogger logger,
        BotTurn turn,
        string outcome,
        string? errorCode,
        ErrorCategory? errorCategory)
    {
        string protocol = turn.ModelProfileSnapshot.Protocol.ToString();
        if (outcome == AmiraTelemetry.Outcomes.Success)
            RuntimeLog.TurnCompleted(
                logger, turn.BotId.Value, turn.ChatId.Value, turn.Id.Value, protocol, turn.ModelProfileSnapshot.Model);
        else if (outcome == AmiraTelemetry.Outcomes.Cancelled)
            RuntimeLog.TurnCancelled(
                logger, turn.BotId.Value, turn.ChatId.Value, turn.Id.Value, protocol, turn.ModelProfileSnapshot.Model);
        else
            RuntimeLog.TurnFailed(
                logger,
                turn.BotId.Value,
                turn.ChatId.Value,
                turn.Id.Value,
                protocol,
                turn.ModelProfileSnapshot.Model,
                errorCode,
                errorCategory?.ToString());
    }

    private enum ScopeKind { Activity, Turn, Provider }
}

internal static partial class RuntimeLog
{
    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnClaimed, Level = LogLevel.Information, Message = "Turn {TurnId} claimed for bot {BotId} in chat {ChatId} using {ProviderProtocol} model {Model}.")]
    public static partial void TurnClaimed(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.MessageCommitted, Level = LogLevel.Information, Message = "Message committed for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model}.")]
    public static partial void MessageCommitted(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnQueued, Level = LogLevel.Information, Message = "Turn {TurnId} queued for bot {BotId} in chat {ChatId} using {ProviderProtocol} model {Model}.")]
    public static partial void TurnQueued(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnCompleted, Level = LogLevel.Information, Message = "Turn {TurnId} completed for bot {BotId} in chat {ChatId} using {ProviderProtocol} model {Model}.")]
    public static partial void TurnCompleted(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnFailed, Level = LogLevel.Warning, Message = "Turn {TurnId} failed for bot {BotId} in chat {ChatId} using {ProviderProtocol} model {Model} with error {ErrorCode}/{ErrorCategory}.")]
    public static partial void TurnFailed(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model, string? errorCode, string? errorCategory);

    [LoggerMessage(EventId = (int)AmiraLogEvent.TurnCancelled, Level = LogLevel.Information, Message = "Turn {TurnId} cancelled for bot {BotId} in chat {ChatId} using {ProviderProtocol} model {Model}.")]
    public static partial void TurnCancelled(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestStarted, Level = LogLevel.Information, Message = "Provider request started for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model}.")]
    public static partial void RequestStarted(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCompleted, Level = LogLevel.Information, Message = "Provider request completed for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model} in {DurationMs} ms with usage {UsageInput}/{UsageOutput} and error {ErrorCode}/{ErrorCategory}.")]
    public static partial void RequestCompleted(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model, double durationMs, int? usageInput, int? usageOutput, string? errorCode, string? errorCategory);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestFailed, Level = LogLevel.Warning, Message = "Provider request failed for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model} in {DurationMs} ms with usage {UsageInput}/{UsageOutput} and error {ErrorCode}/{ErrorCategory}.")]
    public static partial void RequestFailed(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model, double durationMs, int? usageInput, int? usageOutput, string? errorCode, string? errorCategory);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ProviderRequestCancelled, Level = LogLevel.Information, Message = "Provider request cancelled for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model} in {DurationMs} ms with usage {UsageInput}/{UsageOutput} and error {ErrorCode}/{ErrorCategory}.")]
    public static partial void RequestCancelled(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model, double durationMs, int? usageInput, int? usageOutput, string? errorCode, string? errorCategory);

    [LoggerMessage(EventId = (int)AmiraLogEvent.ContextBuilt, Level = LogLevel.Debug, Message = "Context built for turn {TurnId}, bot {BotId}, chat {ChatId}, protocol {ProviderProtocol}, model {Model}: included {IncludedMessages}, dropped {DroppedMessages}, characters {Characters}.")]
    public static partial void ContextBuilt(ILogger logger, string botId, string chatId, string turnId, string providerProtocol, string model, int includedMessages, int droppedMessages, int characters);
}
