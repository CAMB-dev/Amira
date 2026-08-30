using Amira.Domain;
using Amira.Errors;

namespace Amira.Domain.Tests;

public sealed class DomainModelTests
{
    [Fact]
    public void Blank_identifier_is_a_typed_input_error_but_null_remains_a_programming_error()
    {
        AmiraException blank = Assert.Throws<AmiraException>(() => BotId.Create("  "));
        Assert.Equal(ErrorCategory.Input, blank.Category);
        Assert.Throws<ArgumentNullException>(() => BotId.Create(null!));
    }

    [Fact]
    public void Editing_provider_and_model_preserves_profile_and_chat_history_identity()
    {
        ProviderConnectionId firstConnection = ProviderConnectionId.New();
        Bot original = Bot.Create(BotProfile.Create("Amira"), ModelProfile.Create(firstConnection, "model-a"));
        BotTurn historicalTurn = BotTurn.Queue(
            original.Id,
            original.DirectChatId,
            [MessageId.New()],
            original.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible));

        Bot edited = original.EditModelSettings(
            ProviderConnectionId.New(),
            "model-b",
            new GenerationOptions(temperature: 0.5, maxOutputTokens: 512));

        Assert.Equal(original.Id, edited.Id);
        Assert.Equal(original.DirectChatId, edited.DirectChatId);
        Assert.Equal(original.ModelProfile.Id, edited.ModelProfile.Id);
        Assert.NotEqual(original.ModelProfile.ConnectionId, edited.ModelProfile.ConnectionId);
        Assert.Equal("model-b", edited.ModelProfile.Model);
        Assert.Equal(firstConnection, historicalTurn.ModelProfileSnapshot.ConnectionId);
        Assert.Equal("model-a", historicalTurn.ModelProfileSnapshot.Model);
        Assert.Equal(original.ModelProfile.Id, historicalTurn.ModelProfileSnapshot.ModelProfileId);
    }

    [Fact]
    public void Replacing_model_profile_identity_is_a_domain_rule_error()
    {
        Bot bot = Bot.Create(BotProfile.Create("Amira"), ModelProfile.Create(ProviderConnectionId.New(), "model-a"));
        AmiraException exception = Assert.Throws<AmiraException>(() =>
            bot.WithModelProfile(ModelProfile.Create(ProviderConnectionId.New(), "model-b")));

        Assert.Equal("model_profile_identity_mismatch", exception.Code);
        Assert.Equal(ErrorCategory.DomainRule, exception.Category);
    }

    [Fact]
    public void Invalid_turn_transition_is_a_typed_domain_rule_error()
    {
        Bot bot = Bot.Create(BotProfile.Create("Amira"), ModelProfile.Create(ProviderConnectionId.New(), "model"));
        BotTurn queued = BotTurn.Queue(bot.Id, bot.DirectChatId, [MessageId.New()], bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIResponses));

        AmiraException exception = Assert.Throws<AmiraException>(() => queued.Complete());
        Assert.Equal("invalid_turn_transition", exception.Code);
        Assert.Equal(ErrorCategory.DomainRule, exception.Category);
    }
}
