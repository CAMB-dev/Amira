using System.Diagnostics;

namespace Amira.Contracts;

/// <summary>Stable, provider-neutral observability names. Tag values must never contain message bodies or credentials.</summary>
public static class AmiraTelemetry
{
    public const string ActivitySourceName = "Amira.Contracts";
    public const string MessageCommitActivity = "message.commit";
    public const string TurnQueueActivity = "turn.queue";
    public const string ContextBuildActivity = "context.build";
    public const string ProviderRequestActivity = "provider.request";
    public const string ProviderStreamActivity = "provider.stream";
    public static readonly ActivitySource Source = new(ActivitySourceName);

    public static class Tags
    {
        public const string TraceId = "trace_id";
        public const string BotId = "bot_id";
        public const string ChatId = "chat_id";
        public const string TurnId = "turn_id";
        public const string ProviderProtocol = "provider_protocol";
        public const string Model = "model";
        public const string DurationMilliseconds = "duration_ms";
        public const string ErrorCode = "error_code";
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
