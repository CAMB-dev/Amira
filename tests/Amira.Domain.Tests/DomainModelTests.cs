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
    public void Editing_provider_connection_settings_preserves_identity_and_protocol()
    {
        ProviderConnection original = ProviderConnection.Create(
            ProviderProtocol.AnthropicMessages,
            "Original",
            new Uri("https://old.example.test/"),
            CredentialReference.Create("old-credential"),
            "old-model",
            new Dictionary<string, string> { ["X-Original"] = "old" });

        ProviderConnection edited = original.WithSettings(
            "Updated",
            new Uri("https://new.example.test/api/"),
            CredentialReference.Create("new-credential"),
            "new-model",
            new Dictionary<string, string> { ["X-Region"] = "new" },
            enabled: false);

        Assert.Equal(original.Id, edited.Id);
        Assert.Equal(original.Protocol, edited.Protocol);
        Assert.Equal("Updated", edited.DisplayName);
        Assert.Equal(new Uri("https://new.example.test/api/"), edited.BaseUrl);
        Assert.Equal(CredentialReference.Create("new-credential"), edited.CredentialReference);
        Assert.Equal("new-model", edited.DefaultModel);
        Assert.Equal("new", Assert.Single(edited.ExtraHeaders).Value);
        Assert.False(edited.Enabled);
    }

    [Fact]
    public void Editing_provider_connection_settings_reuses_input_and_endpoint_rules()
    {
        ProviderConnection original = ProviderConnection.Create(
            ProviderProtocol.OpenAIResponses,
            "Original",
            new Uri("https://example.test/"),
            CredentialReference.Create("credential"));

        AmiraException blankName = Assert.Throws<AmiraException>(() => original.WithSettings(
            "  ",
            new Uri("https://example.test/"),
            CredentialReference.Create("credential"),
            defaultModel: null,
            extraHeaders: new Dictionary<string, string>(),
            enabled: true));
        AmiraException unsafeEndpoint = Assert.Throws<AmiraException>(() => original.WithSettings(
            "Updated",
            new Uri("http://example.test/"),
            CredentialReference.Create("credential"),
            defaultModel: null,
            extraHeaders: new Dictionary<string, string>(),
            enabled: true));

        Assert.Equal(AmiraErrorCodes.TextRequired, blankName.Code);
        Assert.Equal(ErrorCategory.Input, blankName.Category);
        Assert.Equal(AmiraErrorCodes.InvalidProviderEndpoint, unsafeEndpoint.Code);
        Assert.Equal(ErrorCategory.Configuration, unsafeEndpoint.Category);
    }

    [Fact]
    public void Editing_provider_connection_settings_rejects_secret_headers()
    {
        ProviderConnection original = ProviderConnection.Create(
            ProviderProtocol.OpenAIChatCompatible,
            "Original",
            new Uri("https://example.test/"),
            CredentialReference.Create("credential"));

        AmiraException exception = Assert.Throws<AmiraException>(() => original.WithSettings(
            "Updated",
            new Uri("https://example.test/"),
            CredentialReference.Create("credential"),
            defaultModel: null,
            extraHeaders: new Dictionary<string, string> { ["X-API-Key"] = "secret" },
            enabled: true));

        Assert.Equal(AmiraErrorCodes.CredentialHeaderNotAllowed, exception.Code);
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
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
