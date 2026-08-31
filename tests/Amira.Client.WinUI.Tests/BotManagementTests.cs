using Amira.Contracts;
using Amira.Domain;
using Amira.Runtime;

namespace Amira.Client.WinUI.Tests;

public sealed class BotManagementTests
{
    [Fact]
    public async Task Create_adds_to_both_catalogs_and_selects_the_new_bot()
    {
        ProviderConnection connection = CreateConnection();
        await using var session = new FakeClientSession([], [connection]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();

        bool saved = await viewModel.CreateBotAsync(new BotDraft(
            "  Writer  ",
            "Drafts copy",
            "Be concise",
            connection,
            "gpt-test",
            "0.25",
            "512"));

        Assert.True(saved);
        Bot created = Assert.Single(viewModel.AllBots);
        Assert.Same(created, Assert.Single(viewModel.Bots));
        Assert.Same(created, viewModel.SelectedBot);
        Assert.Equal("Writer", created.Profile.Name);
        Assert.Equal(0.25, created.ModelProfile.GenerationOptions.Temperature);
        Assert.Equal(512, created.ModelProfile.GenerationOptions.MaxOutputTokens);
        Assert.Equal("Bot created.", viewModel.StatusText);
    }

    [Fact]
    public async Task Edit_preserves_aggregate_profile_and_model_profile_identity()
    {
        ProviderConnection connection = CreateConnection();
        Bot original = CreateBot("Original", connection, providerOptions: new Dictionary<string, string> { ["reasoning"] = "low" });
        await using var session = new FakeClientSession([original], [connection]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        BotDraft draft = BotDraft.ForEdit(original, viewModel.Connections) with
        {
            Name = "Edited",
            Description = "Changed",
            Instructions = "New instructions",
            Model = "gpt-edited",
            Temperature = "1.5",
            MaxTokens = "2048",
        };

        bool saved = await viewModel.EditBotAsync(draft);

        Assert.True(saved);
        Bot updated = Assert.IsType<Bot>(session.LastUpdated);
        Assert.Equal(original.Id, updated.Id);
        Assert.Equal(original.Profile.Id, updated.Profile.Id);
        Assert.Equal(original.ModelProfile.Id, updated.ModelProfile.Id);
        Assert.Equal(original.DirectChatId, updated.DirectChatId);
        Assert.Equal(original.CreatedAt, updated.CreatedAt);
        Assert.Equal("low", updated.ModelProfile.ProviderOptions["reasoning"]);
        Assert.Equal("Edited", viewModel.SelectedBot?.Profile.Name);
        Assert.Equal(updated.Id, viewModel.SelectedBot?.Id);
    }

    [Fact]
    public async Task Archive_moves_bot_out_of_active_catalog_and_never_leaves_it_selected()
    {
        ProviderConnection connection = CreateConnection();
        Bot first = CreateBot("First", connection);
        Bot second = CreateBot("Second", connection);
        await using var session = new FakeClientSession([first, second], [connection]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        viewModel.MessageText = "hello";
        Assert.Equal(first.Id, viewModel.SelectedBot?.Id);

        bool archived = await viewModel.ArchiveBotAsync(first);

        Assert.True(archived);
        Assert.Equal(BotLifecycleState.Archived, viewModel.AllBots.Single(bot => bot.Id == first.Id).LifecycleState);
        Assert.DoesNotContain(viewModel.Bots, bot => bot.Id == first.Id);
        Assert.Equal(second.Id, viewModel.SelectedBot?.Id);
        Assert.True(viewModel.CanSend);

        Bot archivedBot = viewModel.AllBots.Single(bot => bot.Id == first.Id);
        await viewModel.SelectBotAsync(archivedBot);
        Assert.Equal(second.Id, viewModel.SelectedBot?.Id);
        Assert.Contains("bot_inactive", viewModel.StatusText, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Archiving_the_only_selected_bot_clears_selection_and_send_state()
    {
        ProviderConnection connection = CreateConnection();
        Bot bot = CreateBot("Only", connection);
        await using var session = new FakeClientSession([bot], [connection]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        viewModel.MessageText = "hello";

        bool archived = await viewModel.ArchiveBotAsync(bot);

        Assert.True(archived);
        Assert.Null(viewModel.SelectedBot);
        Assert.Empty(viewModel.Bots);
        Assert.Single(viewModel.AllBots);
        Assert.False(viewModel.CanSend);
    }

    [Fact]
    public async Task Restore_returns_bot_to_active_catalog_and_selects_it_when_catalog_was_empty()
    {
        ProviderConnection connection = CreateConnection();
        Bot archivedBot = CreateBot("Archived", connection).Archive();
        await using var session = new FakeClientSession([archivedBot], [connection]);
        var viewModel = new MainViewModel(session);
        await viewModel.InitializeAsync();
        Assert.Null(viewModel.SelectedBot);

        bool restored = await viewModel.RestoreBotAsync(archivedBot);

        Assert.True(restored);
        Bot active = Assert.Single(viewModel.Bots);
        Assert.Equal(BotLifecycleState.Active, active.LifecycleState);
        Assert.Same(active, viewModel.SelectedBot);
        Assert.False(viewModel.HasArchivedBots);
    }

    [Fact]
    public async Task Invalid_draft_uses_product_error_presentation_and_does_not_create()
    {
        ProviderConnection connection = CreateConnection();
        await using var session = new FakeClientSession([], [connection]);
        var viewModel = new MainViewModel(session);

        bool saved = await viewModel.CreateBotAsync(new BotDraft(
            "Bot",
            "",
            "",
            connection,
            "gpt-test",
            "NaN",
            "512"));

        Assert.False(saved);
        Assert.Empty(viewModel.AllBots);
        Assert.Null(session.LastCreated);
        Assert.Contains("invalid_temperature", viewModel.StatusText, StringComparison.Ordinal);
    }

    [Fact]
    public void Edit_draft_round_trips_optional_generation_values_in_invariant_form()
    {
        ProviderConnection connection = CreateConnection();
        Bot bot = CreateBot("Bot", connection, temperature: null, maxTokens: null);

        BotDraft draft = BotDraft.ForEdit(bot, [connection]);
        Bot edited = BotDraftPolicy.ApplyEdit(draft with { Name = "Changed" });

        Assert.Equal(string.Empty, draft.Temperature);
        Assert.Equal(string.Empty, draft.MaxTokens);
        Assert.Same(connection, draft.Connection);
        Assert.Equal(bot.Id, edited.Id);
        Assert.Equal(bot.Profile.Id, edited.Profile.Id);
        Assert.Equal(bot.ModelProfile.Id, edited.ModelProfile.Id);
        Assert.Null(edited.ModelProfile.GenerationOptions.Temperature);
        Assert.Null(edited.ModelProfile.GenerationOptions.MaxOutputTokens);
    }

    [Fact]
    public void Lifecycle_policy_distinguishes_active_and_archived_actions()
    {
        ProviderConnection connection = CreateConnection();
        Bot active = CreateBot("Active", connection);
        Bot archived = CreateBot("Archived", connection).Archive();

        Assert.True(BotManagementPolicy.CanSelect(active));
        Assert.True(BotManagementPolicy.CanArchive(active));
        Assert.False(BotManagementPolicy.CanRestore(active));
        Assert.False(BotManagementPolicy.CanSelect(archived));
        Assert.False(BotManagementPolicy.CanArchive(archived));
        Assert.True(BotManagementPolicy.CanRestore(archived));
        Assert.True(BotManagementPolicy.CanEdit(archived));
    }

    private static ProviderConnection CreateConnection() => ProviderConnection.Create(
        ProviderProtocol.OpenAIResponses,
        "Test",
        new Uri("https://example.test"),
        CredentialReference.Create($"provider/{Guid.NewGuid():N}"),
        "gpt-test");

    private static Bot CreateBot(
        string name,
        ProviderConnection connection,
        double? temperature = 0.7,
        int? maxTokens = 1024,
        IReadOnlyDictionary<string, string>? providerOptions = null) =>
        Bot.Create(
            BotProfile.Create(name, $"{name} description", $"{name} instructions"),
            ModelProfile.Create(
                connection.Id,
                connection.DefaultModel!,
                new GenerationOptions(temperature, maxTokens),
                providerOptions));

    private sealed class FakeClientSession : IClientSession
    {
        private readonly List<Bot> _bots;
        private readonly List<ProviderConnection> _connections;

        public FakeClientSession(IEnumerable<Bot> bots, IEnumerable<ProviderConnection> connections)
        {
            _bots = [.. bots];
            _connections = [.. connections];
        }

        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();
        public CreateBotCommand? LastCreated { get; private set; }
        public Bot? LastUpdated { get; private set; }

        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<Bot>>([.. _bots]);

        public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<ProviderConnection>>([.. _connections]);

        public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default)
        {
            LastCreated = command;
            Bot bot = Bot.Create(command.Profile, command.ModelProfile);
            _bots.Add(bot);
            return ValueTask.FromResult(bot);
        }

        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default)
        {
            LastUpdated = bot;
            ReplaceBot(bot);
            return ValueTask.FromResult(bot);
        }

        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default)
        {
            Bot archived = FindBot(botId).Archive();
            ReplaceBot(archived);
            return ValueTask.FromResult(archived);
        }

        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default)
        {
            Bot restored = FindBot(botId).Restore();
            ReplaceBot(restored);
            return ValueTask.FromResult(restored);
        }

        public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<ChatMessage>>([]);

        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(new TurnPage([], null));

        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public ValueTask DisposeAsync() => ValueTask.CompletedTask;

        private Bot FindBot(BotId botId) => _bots.Single(bot => bot.Id == botId);

        private void ReplaceBot(Bot replacement)
        {
            int index = _bots.FindIndex(bot => bot.Id == replacement.Id);
            Assert.True(index >= 0);
            _bots[index] = replacement;
        }
    }
}
