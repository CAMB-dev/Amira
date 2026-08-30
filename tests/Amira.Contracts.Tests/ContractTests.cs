using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using System.Diagnostics;

namespace Amira.Contracts.Tests;

public sealed class ContractTests
{
    [Fact]
    public void Human_message_command_preserves_exact_content()
    {
        Bot bot = CreateBot();
        ModelProfileSnapshot snapshot = bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible);
        const string content = "  hello\nworld  ";

        var command = new HumanMessageCommand(bot.DirectChatId, content, bot.Id, snapshot);

        Assert.Equal(content, command.Content);
    }

    [Fact]
    public void Provider_stream_vocabulary_has_unambiguous_usage_event()
    {
        ModelStreamEvent usage = new ModelStreamEvent.Usage(new ProviderUsage(3, 5));

        Assert.Equal(5, Assert.IsType<ModelStreamEvent.Usage>(usage).Value.OutputTokens);
        Assert.Equal("provider.request", AmiraTelemetry.ProviderRequestActivity);
        Assert.Equal("turn.execute", AmiraTelemetry.TurnExecuteActivity);
        Assert.Equal("Amira.Runtime", AmiraTelemetry.ActivitySourceName);
        Assert.Equal("Amira.Runtime", AmiraTelemetry.MeterName);
        Assert.Equal(1200, (int)AmiraLogEvent.ProviderRequestStarted);
        Assert.Equal("amira.provider.request.count", AmiraTelemetry.Metrics.ProviderRequestCount);
    }

    [Fact]
    public void Durable_turn_contract_round_trips_optional_activity_context_without_domain_coupling()
    {
        Bot bot = CreateBot();
        var parent = new ActivityContext(
            ActivityTraceId.CreateRandom(),
            ActivitySpanId.CreateRandom(),
            ActivityTraceFlags.Recorded,
            "vendor=value",
            true);
        var command = new HumanMessageCommand(
            bot.DirectChatId,
            "hello",
            bot.Id,
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible),
            parent);
        BotTurn turn = BotTurn.Queue(
            bot.Id,
            bot.DirectChatId,
            [MessageId.New()],
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible));
        var claimed = new ClaimedTurn(turn.Start(), TurnClaimToken.New(), command.ParentActivityContext);

        Assert.Equal(parent, claimed.ParentActivityContext);
        Assert.Equal(default, new HumanMessageCommand(
            bot.DirectChatId,
            "hello",
            bot.Id,
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible)).ParentActivityContext);
    }

    [Fact]
    public void Contract_identifier_validation_uses_typed_input_error()
    {
        AmiraException exception = Assert.Throws<AmiraException>(() => new TurnClaimToken(" "));
        Assert.Equal(ErrorCategory.Input, exception.Category);
    }

    [Fact]
    public void Request_connection_mismatch_uses_typed_domain_error()
    {
        Bot bot = CreateBot();
        var request = new ModelRequest(
            WorkspaceId.New(),
            bot.Id,
            bot.DirectChatId,
            BotTurnId.New(),
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible),
            [new ModelMessage(ModelMessageRole.User, "hello")]);
        ProviderConnection wrong = ProviderConnection.Create(
            ProviderProtocol.AnthropicMessages,
            "wrong",
            new Uri("https://example.test"),
            CredentialReference.Create("wrong"));

        AmiraException exception = Assert.Throws<AmiraException>(() => request.ValidateConnection(wrong));

        Assert.Equal("snapshot_mismatch", exception.Code);
        Assert.Equal(ErrorCategory.DomainRule, exception.Category);
    }

    private static Bot CreateBot() =>
        Bot.Create(BotProfile.Create("Amira"), ModelProfile.Create(ProviderConnectionId.New(), "model"));
}
