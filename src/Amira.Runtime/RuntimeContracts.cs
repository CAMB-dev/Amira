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
