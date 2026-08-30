using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Runtime;

public abstract record ChatRuntimeEvent(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model)
{
    public sealed record Started(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model) : ChatRuntimeEvent(TurnId, BotId, Protocol, Model);
    public sealed record TextDelta(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model, string Text) : ChatRuntimeEvent(TurnId, BotId, Protocol, Model);
    public sealed record UsageReported(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model, ProviderUsage Value) : ChatRuntimeEvent(TurnId, BotId, Protocol, Model);
    public sealed record Completed : ChatRuntimeEvent
    {
        public Completed(BotTurnId turnId, BotId botId, ProviderProtocol protocol, string model, string text, ProviderUsage? usage)
            : base(turnId, botId, protocol, model) => (Text, Usage) = (text, usage);
        public string Text { get; }
        public ProviderUsage? Usage { get; }
    }
    public sealed record Failed(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model, AmiraError Failure) : ChatRuntimeEvent(TurnId, BotId, Protocol, Model);
    public sealed record Cancelled(BotTurnId TurnId, BotId BotId, ProviderProtocol Protocol, string Model) : ChatRuntimeEvent(TurnId, BotId, Protocol, Model);
}

public sealed record StopResult(bool DurableStopRequested, bool CancellationSignaled);

/// <summary>Backpressured delivery seam between one Bot worker and its host.</summary>
public interface IChatRuntimeEventSink
{
    ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default);
}

/// <summary>One-shot background execution loop for a single Bot.</summary>
public interface IBotWorker : IAsyncDisposable
{
    BotId BotId { get; }

    Task RunAsync(IChatRuntimeEventSink sink, CancellationToken cancellationToken = default);

    /// <summary>Coalesces pending work into one latched wake signal. May be called before RunAsync.</summary>
    void Wake();
}

/// <summary>Idle polling policy for a Bot worker.</summary>
public sealed record BotWorkerOptions
{
    public TimeSpan InitialIdleDelay { get; init; } = TimeSpan.FromMilliseconds(100);
    public TimeSpan MaximumIdleDelay { get; init; } = TimeSpan.FromSeconds(2);
    public TimeProvider TimeProvider { get; init; } = TimeProvider.System;
}
