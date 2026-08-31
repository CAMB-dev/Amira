using System.Diagnostics;

namespace Amira.Contracts;

/// <summary>Stable, provider-neutral observability names. Tag values must never contain message bodies or credentials.</summary>
public static class AmiraTelemetry
{
    public const string ActivitySourceName = "Amira.Runtime";
    public const string MeterName = "Amira.Runtime";
    public const string InstrumentationVersion = "1.0.0";
    public const string MessageCommitActivity = "message.commit";
    public const string TurnQueueActivity = "turn.queue";
    public const string TurnExecuteActivity = "turn.execute";
    public const string ContextBuildActivity = "context.build";
    public const string ProviderRequestActivity = "provider.request";
    public const string ProviderStreamActivity = "provider.stream";
    public static readonly ActivitySource Source = new(ActivitySourceName, InstrumentationVersion);

    public static class Tags
    {
        public const string TraceId = "trace_id";
        public const string BotId = "bot_id";
        public const string ChatId = "chat_id";
        public const string TurnId = "turn_id";
        public const string ProviderProtocol = "provider_protocol";
        public const string Model = "model";
        public const string DurationMilliseconds = "duration_ms";
        public const string Outcome = "outcome";
        public const string ErrorCode = "error_code";
        public const string ErrorCategory = "error_category";
    }

    public static class Outcomes
    {
        public const string Success = "success";
        public const string Failure = "failure";
        public const string Cancelled = "cancelled";
    }

    public static class ErrorCodes
    {
        public const string OperationCancelled = "operation_cancelled";
        public const string UnexpectedException = "unexpected_exception";
    }

    public static class Metrics
    {
        public const string ProviderRequestCount = "amira.provider.request.count";
        public const string ProviderRequestDuration = "amira.provider.request.duration";
        public const string ProviderTimeToFirstToken = "amira.provider.request.time_to_first_token";
        public const string ProviderInputTokens = "amira.provider.usage.input_tokens";
        public const string ProviderOutputTokens = "amira.provider.usage.output_tokens";
        public const string TurnQueuedTotal = "amira.turn.queued.total";
        public const string QueuedTurns = "amira.turn.queued";
        public const string ActiveTurns = "amira.turn.active";
        public const string TurnStopRequestedTotal = "amira.turn.stop.requested.total";
        public const string TurnCancelledTotal = "amira.turn.cancelled.total";
    }
}

/// <summary>Numeric structured-log vocabulary owned by Contracts; logging implementations map these values to their backend.</summary>
public enum AmiraLogEvent
{
    MessageCommitted = 1000,
    TurnQueued = 1100,
    TurnClaimed = 1101,
    TurnCompleted = 1102,
    TurnFailed = 1103,
    TurnCancelled = 1104,
    ProviderRequestStarted = 1200,
    ProviderRequestCompleted = 1201,
    ProviderRequestFailed = 1202,
    ProviderRequestCancelled = 1203,
    ContextBuilt = 1300
}
