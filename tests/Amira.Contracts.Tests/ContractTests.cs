using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

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
