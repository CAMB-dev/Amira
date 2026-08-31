using System.Collections.Concurrent;
using Amira.Contracts;
using Amira.Domain;
using Amira.Runtime;

namespace Amira.Client.WinUI.Tests;

public sealed class ClientViewStateTests
{
    [Theory]
    [InlineData(true, true, 2, 1, true, 0, BotNavigationState.Loading)]
    [InlineData(false, false, 2, 0, false, 2, BotNavigationState.Content)]
    [InlineData(false, true, 2, 0, true, 0, BotNavigationState.SearchNoResults)]
    [InlineData(false, false, 0, 1, false, 0, BotNavigationState.ArchivedOnly)]
    [InlineData(false, false, 0, 0, false, 0, BotNavigationState.NoEnabledConnections)]
    [InlineData(false, true, 0, 0, false, 0, BotNavigationState.NoBots)]
    public void Navigation_state_has_one_explicit_priority(
        bool isLoading,
        bool hasEnabledConnections,
        int activeBotCount,
        int archivedBotCount,
        bool hasSearchQuery,
        int visibleBotCount,
        BotNavigationState expected)
    {
        BotNavigationState state = ClientViewStatePolicy.ResolveNavigation(
            isLoading,
            hasEnabledConnections,
            activeBotCount,
            archivedBotCount,
            hasSearchQuery,
            visibleBotCount);

        Assert.Equal(expected, state);
    }

    [Theory]
    [InlineData(true, false, 0, 0, ConversationState.Loading)]
    [InlineData(false, false, 4, 1, ConversationState.NoSelection)]
    [InlineData(false, true, 0, 0, ConversationState.EmptyChat)]
    [InlineData(false, true, 1, 0, ConversationState.Content)]
    [InlineData(false, true, 0, 1, ConversationState.Content)]
    public void Conversation_state_keeps_loading_and_streaming_unambiguous(
        bool isLoading,
        bool hasSelection,
        int messageCount,
        int streamingTurnCount,
        ConversationState expected)
    {
        ConversationState state = ClientViewStatePolicy.ResolveConversation(
            isLoading,
            hasSelection,
            messageCount,
            streamingTurnCount);

        Assert.Equal(expected, state);
    }

    [Fact]
    public async Task Initialization_stays_loading_until_each_async_stage_finishes()
    {
        ProviderConnection connection = CreateConnection(enabled: true);
        Bot bot = CreateBot("Mira", connection);
        await using var session = new StateClientSession([bot], [connection], gateCatalog: true, gateConversation: true);
        var viewModel = new MainViewModel(session);
        ConcurrentQueue<BotNavigationState> navigationStates = [];
        ConcurrentQueue<ConversationState> conversationStates = [];
        viewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(MainViewModel.NavigationState))
                navigationStates.Enqueue(viewModel.NavigationState);
            if (args.PropertyName == nameof(MainViewModel.ConversationState))
                conversationStates.Enqueue(viewModel.ConversationState);
        };

        Task initialize = viewModel.InitializeAsync();
        await session.CatalogRequested.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Equal(BotNavigationState.Loading, viewModel.NavigationState);
        Assert.Equal(ConversationState.Loading, viewModel.ConversationState);
        Assert.DoesNotContain(BotNavigationState.NoBots, navigationStates);
        Assert.DoesNotContain(ConversationState.EmptyChat, conversationStates);

        session.ReleaseCatalog();
        await session.ConversationRequested.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        Assert.Equal(BotNavigationState.Content, viewModel.NavigationState);
        Assert.Equal(ConversationState.Loading, viewModel.ConversationState);
        Assert.DoesNotContain(ConversationState.EmptyChat, conversationStates);

        session.ReleaseConversation();
        await initialize;

        Assert.Equal(ConversationState.EmptyChat, viewModel.ConversationState);
        Assert.Contains(BotNavigationState.Content, navigationStates);
        Assert.Contains(ConversationState.EmptyChat, conversationStates);
    }

    [Fact]
    public async Task Empty_catalog_states_reflect_connections_and_archived_bots()
    {
        await using var disconnectedSession = new StateClientSession([], []);
        var disconnected = new MainViewModel(disconnectedSession);
        await disconnected.InitializeAsync();
        Assert.Equal(BotNavigationState.NoEnabledConnections, disconnected.NavigationState);

        ProviderConnection connection = CreateConnection(enabled: true);
        await using var connectedSession = new StateClientSession([], [connection]);
        var connected = new MainViewModel(connectedSession);
        await connected.InitializeAsync();
        Assert.Equal(BotNavigationState.NoBots, connected.NavigationState);

        Bot archivedBot = CreateBot("Archived", connection).Archive();
        await using var archivedSession = new StateClientSession([archivedBot], []);
        var archived = new MainViewModel(archivedSession);
        await archived.InitializeAsync();
        Assert.Equal(BotNavigationState.ArchivedOnly, archived.NavigationState);
    }

    [Fact]
    public async Task Search_state_switches_without_mutating_the_active_catalog()
    {
        ProviderConnection connection = CreateConnection(enabled: true);
        Bot bot = CreateBot("Mira", connection);
        ChatMessage message = CreateMessage(bot, "Keep this conversation open");
        await using var session = new StateClientSession([bot], [connection], timeline: [message]);
        var viewModel = new MainViewModel(session);
        ConcurrentQueue<string?> changes = [];
        viewModel.PropertyChanged += (_, args) => changes.Enqueue(args.PropertyName);
        await viewModel.InitializeAsync();
        changes.Clear();

        viewModel.SearchText = "Atlas";

        Assert.Equal(BotNavigationState.SearchNoResults, viewModel.NavigationState);
        Assert.Empty(viewModel.VisibleBots);
        Assert.Single(viewModel.Bots);
        Assert.Same(bot, viewModel.SelectedBot);
        Assert.Same(message, Assert.Single(viewModel.Timeline));
        Assert.False(BotNavigationSelectionPolicy.ShouldOpen(null, viewModel.SelectedBot));
        Assert.Contains(nameof(MainViewModel.NavigationState), changes);
        Assert.Contains(nameof(MainViewModel.SelectedBot), changes);

        changes.Clear();
        viewModel.SearchText = string.Empty;

        Assert.Equal(BotNavigationState.Content, viewModel.NavigationState);
        Assert.Same(bot, Assert.Single(viewModel.VisibleBots));
        Assert.Same(bot, viewModel.SelectedBot);
        Assert.Same(message, Assert.Single(viewModel.Timeline));
        Assert.Contains(nameof(MainViewModel.SelectedBot), changes);
    }

    [Fact]
    public void Navigation_selection_policy_only_opens_a_different_concrete_bot()
    {
        ProviderConnection connection = CreateConnection(enabled: true);
        Bot current = CreateBot("Current", connection);
        Bot other = CreateBot("Other", connection);

        Assert.False(BotNavigationSelectionPolicy.ShouldOpen(null, current));
        Assert.False(BotNavigationSelectionPolicy.ShouldOpen(current, current));
        Assert.True(BotNavigationSelectionPolicy.ShouldOpen(other, current));
        Assert.True(BotNavigationSelectionPolicy.ShouldOpen(other, null));
    }

    private static ProviderConnection CreateConnection(bool enabled) => ProviderConnection.Create(
        ProviderProtocol.OpenAIResponses,
        "Test",
        new Uri("https://example.test"),
        CredentialReference.Create($"provider/{Guid.NewGuid():N}"),
        "test-model",
        enabled: enabled);

    private static Bot CreateBot(string name, ProviderConnection connection) => Bot.Create(
        BotProfile.Create(name, $"{name} description", $"{name} instructions"),
        ModelProfile.Create(connection.Id, connection.DefaultModel!, new GenerationOptions()));

    private static ChatMessage CreateMessage(Bot bot, string content)
    {
        MessageId messageId = MessageId.New();
        MessageRevision revision = MessageRevision.Create(messageId, content);
        return new ChatMessage(
            messageId,
            bot.DirectChatId,
            MessageAuthor.Bot,
            revision,
            revision.CreatedAt,
            MessageStatus.Committed);
    }

    private sealed class StateClientSession : IClientSession
    {
        private readonly IReadOnlyList<Bot> _bots;
        private readonly IReadOnlyList<ProviderConnection> _connections;
        private readonly IReadOnlyList<ChatMessage> _timeline;
        private readonly TaskCompletionSource _catalogGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _conversationGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly bool _gateCatalog;
        private readonly bool _gateConversation;

        public StateClientSession(
            IReadOnlyList<Bot> bots,
            IReadOnlyList<ProviderConnection> connections,
            bool gateCatalog = false,
            bool gateConversation = false,
            IReadOnlyList<ChatMessage>? timeline = null)
        {
            _bots = bots;
            _connections = connections;
            _timeline = timeline ?? [];
            _gateCatalog = gateCatalog;
            _gateConversation = gateConversation;
        }

        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();
        public string LogsDirectory { get; } = @"D:\Amira\logs";
        public TaskCompletionSource CatalogRequested { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource ConversationRequested { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public void ReleaseCatalog() => _catalogGate.TrySetResult();
        public void ReleaseConversation() => _conversationGate.TrySetResult();

        public async ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default)
        {
            CatalogRequested.TrySetResult();
            if (_gateCatalog) await _catalogGate.Task.WaitAsync(cancellationToken);
            return _bots;
        }

        public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult(_connections);

        public async ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default)
        {
            ConversationRequested.TrySetResult();
            if (_gateConversation) await _conversationGate.Task.WaitAsync(cancellationToken);
            return _timeline;
        }

        public async ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default)
        {
            ConversationRequested.TrySetResult();
            if (_gateConversation) await _conversationGate.Task.WaitAsync(cancellationToken);
            return new TurnPage([], null);
        }

        public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => ValueTask.FromResult<TurnView?>(null);
        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
