using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Client.WinUI.Tests;

public sealed class ConnectionManagementTests
{
    [Theory]
    [InlineData(ProviderProtocol.OpenAIChatCompatible)]
    [InlineData(ProviderProtocol.OpenAIResponses)]
    [InlineData(ProviderProtocol.AnthropicMessages)]
    public void Create_draft_supports_each_provider_protocol(ProviderProtocol protocol)
    {
        ConnectionDraft draft = ConnectionDraft.ForCreate(protocol);

        Assert.Equal(protocol, draft.Protocol);
        Assert.True(draft.Enabled);
        Assert.Null(draft.Editing);
    }

    [Fact]
    public void Edit_draft_round_trips_existing_non_secret_settings()
    {
        ProviderConnection connection = CreateConnection(
            ProviderProtocol.AnthropicMessages,
            extraHeaders: new Dictionary<string, string> { ["X-Tenant"] = "amira" },
            enabled: false);

        ConnectionDraft draft = ConnectionDraft.ForEdit(connection);
        ValidatedConnectionDraft values = ConnectionDraftPolicy.Validate(draft with
        {
            Protocol = ProviderProtocol.OpenAIResponses,
        });

        Assert.Same(connection, draft.Editing);
        Assert.Equal(connection.DisplayName, draft.DisplayName);
        Assert.Equal(connection.BaseUrl.AbsoluteUri, draft.BaseUrl);
        Assert.Equal(connection.DefaultModel, draft.DefaultModel);
        Assert.False(draft.Enabled);
        Assert.Equal(connection.Protocol, values.Protocol);
        Assert.Same(connection, values.Editing);
    }

    [Fact]
    public void Validation_normalizes_display_name_and_optional_default_model()
    {
        ConnectionDraft draft = ConnectionDraft.ForCreate() with
        {
            DisplayName = "  Primary  ",
            BaseUrl = "https://example.test/v1/",
            DefaultModel = "   ",
        };

        ValidatedConnectionDraft values = ConnectionDraftPolicy.Validate(draft);

        Assert.Equal("Primary", values.DisplayName);
        Assert.Equal(new Uri("https://example.test/v1/"), values.BaseUrl);
        Assert.Null(values.DefaultModel);
    }

    [Theory]
    [InlineData("relative/path")]
    [InlineData("ftp://example.test/v1")]
    [InlineData("http://example.test/v1")]
    [InlineData("https://user:password@example.test/v1")]
    [InlineData("https://example.test/v1?tenant=amira")]
    [InlineData("https://example.test/v1#section")]
    public void Invalid_base_url_is_a_stable_product_error(string baseUrl)
    {
        ConnectionDraft draft = ConnectionDraft.ForCreate() with
        {
            DisplayName = "Primary",
            BaseUrl = baseUrl,
        };

        AmiraException error = Assert.Throws<AmiraException>(() => ConnectionDraftPolicy.Validate(draft));

        Assert.Equal(AmiraErrorCodes.InvalidProviderEndpoint, error.Code);
        Assert.Equal(
            "The provider endpoint must be absolute HTTPS, or loopback HTTP, without user information, query, or fragment.",
            error.Message);
    }

    [Theory]
    [InlineData("https://example.test/v1/")]
    [InlineData("http://localhost:11434/v1/")]
    [InlineData("http://127.0.0.1:8080/v1/")]
    public void Secure_https_and_loopback_http_base_urls_are_valid(string baseUrl)
    {
        ConnectionDraft draft = ConnectionDraft.ForCreate() with
        {
            DisplayName = "Primary",
            BaseUrl = baseUrl,
        };

        ValidatedConnectionDraft values = ConnectionDraftPolicy.Validate(draft);

        Assert.Equal(new Uri(baseUrl), values.BaseUrl);
    }

    [Fact]
    public void Blank_display_name_is_a_stable_product_error()
    {
        ConnectionDraft draft = ConnectionDraft.ForCreate() with
        {
            DisplayName = " ",
            BaseUrl = "https://example.test",
        };

        AmiraException error = Assert.Throws<AmiraException>(() => ConnectionDraftPolicy.Validate(draft));

        Assert.Equal(AmiraErrorCodes.TextRequired, error.Code);
    }

    [Fact]
    public void Secret_is_required_only_for_new_connections()
    {
        ConnectionDraft create = ConnectionDraft.ForCreate();
        ProviderConnection connection = CreateConnection(ProviderProtocol.OpenAIResponses);
        ConnectionDraft edit = ConnectionDraft.ForEdit(connection);

        AmiraException error = Assert.Throws<AmiraException>(() => ConnectionDraftPolicy.RequireCreateSecret(create, " "));
        ConnectionDraftPolicy.RequireCreateSecret(edit, null);

        Assert.Equal(AmiraErrorCodes.CredentialMissing, error.Code);
    }

    [Fact]
    public async Task Create_refreshes_disabled_connection_and_summary_without_retaining_secret()
    {
        await using var session = new FakeClientSession();
        var viewModel = new MainViewModel(session);
        var propertyChanges = new List<string?>();
        viewModel.PropertyChanged += (_, args) => propertyChanges.Add(args.PropertyName);
        ConnectionDraft draft = ConnectionDraft.ForCreate(ProviderProtocol.AnthropicMessages) with
        {
            DisplayName = "Anthropic",
            BaseUrl = "https://api.anthropic.test/v1/",
            DefaultModel = " ",
            Enabled = false,
        };

        bool saved = await viewModel.SaveConnectionAsync(draft, "create-secret");

        Assert.True(saved);
        ProviderConnection created = Assert.Single(viewModel.Connections);
        Assert.Equal(ProviderProtocol.AnthropicMessages, created.Protocol);
        Assert.Equal("Anthropic", created.DisplayName);
        Assert.Null(created.DefaultModel);
        Assert.False(created.Enabled);
        Assert.True(session.CreateReceivedNonBlankSecret);
        Assert.False(viewModel.HasEnabledConnections);
        Assert.Equal("None enabled", viewModel.ConnectionSummary);
        Assert.Contains(nameof(MainViewModel.HasEnabledConnections), propertyChanges);
        Assert.Contains(nameof(MainViewModel.ConnectionSummary), propertyChanges);
        Assert.Equal("Connection saved.", viewModel.StatusText);
    }

    [Fact]
    public async Task Edit_preserves_identity_protocol_headers_and_credential_when_secret_is_blank()
    {
        ProviderConnection original = CreateConnection(
            ProviderProtocol.OpenAIChatCompatible,
            extraHeaders: new Dictionary<string, string> { ["X-Tenant"] = "amira" },
            enabled: false);
        await using var session = new FakeClientSession([original]);
        var viewModel = new MainViewModel(session);
        await viewModel.RefreshCatalogAsync();
        ConnectionDraft draft = ConnectionDraft.ForEdit(original) with
        {
            Protocol = ProviderProtocol.AnthropicMessages,
            DisplayName = "Updated",
            BaseUrl = "https://updated.example.test/v1/",
            DefaultModel = "gpt-updated",
            Enabled = true,
        };

        bool saved = await viewModel.SaveConnectionAsync(draft, "   ");

        Assert.True(saved);
        ProviderConnection updated = Assert.Single(viewModel.Connections);
        Assert.Equal(original.Id, updated.Id);
        Assert.Equal(original.Protocol, updated.Protocol);
        Assert.Equal(original.CredentialReference, updated.CredentialReference);
        Assert.Equal(original.ExtraHeaders, updated.ExtraHeaders);
        Assert.Equal("amira", updated.ExtraHeaders["X-Tenant"]);
        Assert.Equal("Updated", updated.DisplayName);
        Assert.True(updated.Enabled);
        Assert.True(session.UpdateReceivedNullReplacementSecret);
        Assert.True(viewModel.HasEnabledConnections);
        Assert.Equal("1 enabled", viewModel.ConnectionSummary);
    }

    [Fact]
    public async Task Summary_counts_enabled_configurations_without_claiming_connectivity()
    {
        await using var session = new FakeClientSession();
        var viewModel = new MainViewModel(session);

        Assert.Equal("None enabled", viewModel.ConnectionSummary);
        viewModel.Connections.Add(CreateConnection(ProviderProtocol.OpenAIResponses));
        viewModel.Connections.Add(CreateConnection(ProviderProtocol.AnthropicMessages, enabled: false));
        Assert.Equal("1 enabled", viewModel.ConnectionSummary);
        viewModel.Connections.Add(CreateConnection(ProviderProtocol.OpenAIChatCompatible));
        Assert.Equal("2 enabled", viewModel.ConnectionSummary);
    }

    [Fact]
    public async Task Invalid_url_and_missing_create_key_use_error_presentation_and_do_not_save()
    {
        await using var session = new FakeClientSession();
        var viewModel = new MainViewModel(session);
        ConnectionDraft invalidUrl = ConnectionDraft.ForCreate() with
        {
            DisplayName = "Primary",
            BaseUrl = "not-a-url",
        };

        bool urlSaved = await viewModel.SaveConnectionAsync(invalidUrl, "secret");
        string urlStatus = viewModel.StatusText;
        ConnectionDraft missingKey = invalidUrl with { BaseUrl = "https://example.test" };
        bool keySaved = await viewModel.SaveConnectionAsync(missingKey, null);

        Assert.False(urlSaved);
        Assert.Contains(AmiraErrorCodes.InvalidProviderEndpoint, urlStatus, StringComparison.Ordinal);
        Assert.False(keySaved);
        Assert.Contains(AmiraErrorCodes.CredentialMissing, viewModel.StatusText, StringComparison.Ordinal);
        Assert.Equal(0, session.CreateCalls);
        Assert.Empty(viewModel.Connections);
    }

    private static ProviderConnection CreateConnection(
        ProviderProtocol protocol,
        IReadOnlyDictionary<string, string>? extraHeaders = null,
        bool enabled = true) =>
        ProviderConnection.Create(
            protocol,
            "Existing",
            new Uri("https://example.test/v1/"),
            CredentialReference.Create($"provider/{Guid.NewGuid():N}"),
            "default-model",
            extraHeaders,
            enabled);

    private sealed class FakeClientSession : IClientSession
    {
        private readonly List<ProviderConnection> _connections;

        public FakeClientSession(IEnumerable<ProviderConnection>? connections = null) =>
            _connections = connections is null ? [] : [.. connections];

        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();
        public int CreateCalls { get; private set; }
        public bool CreateReceivedNonBlankSecret { get; private set; }
        public bool UpdateReceivedNullReplacementSecret { get; private set; }

        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<Bot>>([]);

        public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<ProviderConnection>>([.. _connections]);

        public ValueTask<ProviderConnection> CreateProviderConnectionAsync(
            ProviderProtocol protocol,
            string displayName,
            Uri baseUrl,
            string secret,
            string? defaultModel,
            bool enabled,
            CancellationToken cancellationToken = default)
        {
            CreateCalls++;
            CreateReceivedNonBlankSecret = !string.IsNullOrWhiteSpace(secret);
            ProviderConnection created = ProviderConnection.Create(
                protocol,
                displayName,
                baseUrl,
                CredentialReference.Create($"provider/{Guid.NewGuid():N}"),
                defaultModel,
                enabled: enabled);
            _connections.Add(created);
            return ValueTask.FromResult(created);
        }

        public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(
            ProviderConnection current,
            string displayName,
            Uri baseUrl,
            string? replacementSecret,
            string? defaultModel,
            bool enabled,
            CancellationToken cancellationToken = default)
        {
            UpdateReceivedNullReplacementSecret = replacementSecret is null;
            CredentialReference credentialReference = replacementSecret is null
                ? current.CredentialReference
                : CredentialReference.Create($"provider/{Guid.NewGuid():N}");
            ProviderConnection updated = current.WithSettings(
                displayName,
                baseUrl,
                credentialReference,
                defaultModel,
                current.ExtraHeaders,
                enabled);
            int index = _connections.FindIndex(connection => connection.Id == current.Id);
            _connections[index] = updated;
            return ValueTask.FromResult(updated);
        }

        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
