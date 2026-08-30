using System.Collections.ObjectModel;
using Amira.Errors;

namespace Amira.Domain;

public enum BotLifecycleState { Active, Archived }
public enum MessageAuthor { Human, Bot }
public enum MessageStatus { Committed, Deleted }
public enum BotTurnStatus { Queued, Running, Completed, Failed, Cancelled }
public enum ProviderProtocol { OpenAIChatCompatible, OpenAIResponses, AnthropicMessages }

/// <summary>Immutable editable identity and behaviour profile for a Bot.</summary>
public sealed record BotProfile
{
    private BotProfile(BotProfileId id, string name, string description, string instructions, DateTimeOffset createdAt, DateTimeOffset updatedAt)
    {
        if (id.IsEmpty) throw new ArgumentException("Bot profile ID is required.", nameof(id));
        Id = id;
        Name = RequireText(name, nameof(name));
        Description = description ?? string.Empty;
        Instructions = instructions ?? string.Empty;
        CreatedAt = createdAt;
        UpdatedAt = updatedAt;
    }

    public BotProfileId Id { get; }
    public string Name { get; }
    public string Description { get; }
    public string Instructions { get; }
    public DateTimeOffset CreatedAt { get; }
    public DateTimeOffset UpdatedAt { get; }

    public static BotProfile Create(string name, string? description = null, string? instructions = null, DateTimeOffset? now = null)
    {
        DateTimeOffset timestamp = now ?? DateTimeOffset.UtcNow;
        return new(BotProfileId.New(), name, description ?? string.Empty, instructions ?? string.Empty, timestamp, timestamp);
    }

    public static BotProfile Rehydrate(BotProfileId id, string name, string? description, string? instructions, DateTimeOffset createdAt, DateTimeOffset updatedAt) =>
        new(id, name, description ?? string.Empty, instructions ?? string.Empty, createdAt, updatedAt);

    public BotProfile Edit(string name, string? description = null, string? instructions = null, DateTimeOffset? now = null) =>
        new(Id, name, description ?? string.Empty, instructions ?? string.Empty, CreatedAt, now ?? DateTimeOffset.UtcNow);

    internal static string RequireText(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (string.IsNullOrWhiteSpace(value))
            throw new AmiraException(new(AmiraErrorCodes.TextRequired, ErrorCategory.Input, "A text value is required."));
        return value.Trim();
    }

    internal static string RequireContent(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (value.Length == 0)
            throw new AmiraException(new(AmiraErrorCodes.ContentRequired, ErrorCategory.Input, "Content is required."));
        return value;
    }
}

public sealed record GenerationOptions
{
    public GenerationOptions(double? temperature = null, int? maxOutputTokens = null)
    {
        if (temperature is < 0 or > 2)
            throw new AmiraException(new(AmiraErrorCodes.InvalidTemperature, ErrorCategory.Input, "Temperature must be between 0 and 2."));
        if (maxOutputTokens is <= 0)
            throw new AmiraException(new(AmiraErrorCodes.InvalidMaxOutputTokens, ErrorCategory.Input, "Maximum output tokens must be positive."));
        Temperature = temperature;
        MaxOutputTokens = maxOutputTokens;
    }

    public double? Temperature { get; }
    public int? MaxOutputTokens { get; }
}

/// <summary>Provider-neutral model selection. Provider-specific options remain opaque key/value data for adapters.</summary>
public sealed record ModelProfile
{
    private ModelProfile(ModelProfileId id, ProviderConnectionId connectionId, string model, GenerationOptions generationOptions, IReadOnlyDictionary<string, string> providerOptions)
    {
        if (id.IsEmpty) throw new ArgumentException("Model profile ID is required.", nameof(id));
        if (connectionId.IsEmpty) throw new ArgumentException("Connection ID is required.", nameof(connectionId));
        Id = id;
        ConnectionId = connectionId;
        Model = BotProfile.RequireText(model, nameof(model));
        GenerationOptions = generationOptions ?? throw new ArgumentNullException(nameof(generationOptions));
        ProviderOptions = FreezeDictionary(providerOptions, nameof(providerOptions));
    }

    public ModelProfileId Id { get; }
    public ProviderConnectionId ConnectionId { get; }
    public string Model { get; }
    public GenerationOptions GenerationOptions { get; }
    public IReadOnlyDictionary<string, string> ProviderOptions { get; }

    public static ModelProfile Create(ProviderConnectionId connectionId, string model, GenerationOptions? generationOptions = null, IReadOnlyDictionary<string, string>? providerOptions = null) =>
        new(ModelProfileId.New(), connectionId, model, generationOptions ?? new GenerationOptions(), providerOptions ?? new Dictionary<string, string>());

    public static ModelProfile Rehydrate(ModelProfileId id, ProviderConnectionId connectionId, string model, GenerationOptions generationOptions, IReadOnlyDictionary<string, string> providerOptions) =>
        new(id, connectionId, model, generationOptions, providerOptions);

    /// <summary>Edits provider/model settings while preserving this profile's durable identity.</summary>
    public ModelProfile WithSettings(
        ProviderConnectionId connectionId,
        string model,
        GenerationOptions? generationOptions = null,
        IReadOnlyDictionary<string, string>? providerOptions = null) =>
        new(Id, connectionId, model, generationOptions ?? GenerationOptions, providerOptions ?? ProviderOptions);

    public ModelProfileSnapshot Snapshot(ProviderProtocol protocol) =>
        new(Id, ConnectionId, protocol, Model, GenerationOptions, ProviderOptions);

    internal static IReadOnlyDictionary<string, string> FreezeDictionary(IReadOnlyDictionary<string, string> source, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(source, parameterName);
        var copy = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in source)
        {
            var key = BotProfile.RequireText(pair.Key, nameof(pair.Key));
            var value = pair.Value ?? throw new ArgumentException("Dictionary values cannot be null.", parameterName);
            copy[key] = value;
        }

        return new ReadOnlyDictionary<string, string>(copy);
    }
}

/// <summary>Immutable provider-neutral settings captured for one BotTurn.</summary>
public sealed record ModelProfileSnapshot
{
    public ModelProfileSnapshot(ModelProfileId modelProfileId, ProviderConnectionId connectionId, ProviderProtocol protocol, string model, GenerationOptions generationOptions, IReadOnlyDictionary<string, string> providerOptions)
    {
        if (modelProfileId.IsEmpty) throw new ArgumentException("Model profile ID is required.", nameof(modelProfileId));
        if (connectionId.IsEmpty) throw new ArgumentException("Connection ID is required.", nameof(connectionId));
        ModelProfileId = modelProfileId;
        ConnectionId = connectionId;
        Protocol = protocol;
        Model = BotProfile.RequireText(model, nameof(model));
        GenerationOptions = generationOptions ?? throw new ArgumentNullException(nameof(generationOptions));
        ProviderOptions = ModelProfile.FreezeDictionary(providerOptions, nameof(providerOptions));
    }

    public ModelProfileId ModelProfileId { get; }
    public ProviderConnectionId ConnectionId { get; }
    public ProviderProtocol Protocol { get; }
    public string Model { get; }
    public GenerationOptions GenerationOptions { get; }
    public IReadOnlyDictionary<string, string> ProviderOptions { get; }
}

public sealed record ProviderConnection
{
    private ProviderConnection(ProviderConnectionId id, ProviderProtocol protocol, string displayName, Uri baseUrl, CredentialReference credentialReference, string? defaultModel, IReadOnlyDictionary<string, string> extraHeaders, bool enabled)
    {
        if (id.IsEmpty) throw new ArgumentException("Provider connection ID is required.", nameof(id));
        if (credentialReference.IsEmpty) throw new ArgumentException("Credential reference is required.", nameof(credentialReference));
        Id = id;
        Protocol = protocol;
        DisplayName = BotProfile.RequireText(displayName, nameof(displayName));
        BaseUrl = baseUrl ?? throw new ArgumentNullException(nameof(baseUrl));
        if (!baseUrl.IsAbsoluteUri || (baseUrl.Scheme != Uri.UriSchemeHttps && !(baseUrl.Scheme == Uri.UriSchemeHttp && baseUrl.IsLoopback)) || !string.IsNullOrEmpty(baseUrl.UserInfo) || !string.IsNullOrEmpty(baseUrl.Query) || !string.IsNullOrEmpty(baseUrl.Fragment))
                throw new AmiraException(new(AmiraErrorCodes.InvalidProviderEndpoint, ErrorCategory.Configuration, "The provider endpoint must be absolute HTTPS, or loopback HTTP, without user information, query, or fragment."));
        CredentialReference = credentialReference;
        DefaultModel = string.IsNullOrWhiteSpace(defaultModel) ? null : defaultModel.Trim();
        foreach (var headerName in extraHeaders.Keys)
        {
            if (IsSecretHeaderName(headerName))
                throw new AmiraException(new(AmiraErrorCodes.CredentialHeaderNotAllowed, ErrorCategory.Configuration, "Credential-bearing headers are not allowed in provider configuration."));
        }
        ExtraHeaders = ModelProfile.FreezeDictionary(extraHeaders, nameof(extraHeaders));
        Enabled = enabled;
    }

    public ProviderConnectionId Id { get; }
    public ProviderProtocol Protocol { get; }
    public string DisplayName { get; }
    public Uri BaseUrl { get; }
    public CredentialReference CredentialReference { get; }
    public string? DefaultModel { get; }
    public IReadOnlyDictionary<string, string> ExtraHeaders { get; }
    public bool Enabled { get; }

    public static ProviderConnection Create(ProviderProtocol protocol, string displayName, Uri baseUrl, CredentialReference credentialReference, string? defaultModel = null, IReadOnlyDictionary<string, string>? extraHeaders = null, bool enabled = true) =>
        new(ProviderConnectionId.New(), protocol, displayName, baseUrl, credentialReference, defaultModel, extraHeaders ?? new Dictionary<string, string>(), enabled);

    public static ProviderConnection Rehydrate(ProviderConnectionId id, ProviderProtocol protocol, string displayName, Uri baseUrl, CredentialReference credentialReference, string? defaultModel, IReadOnlyDictionary<string, string> extraHeaders, bool enabled) =>
        new(id, protocol, displayName, baseUrl, credentialReference, defaultModel, extraHeaders, enabled);

    private static bool IsSecretHeaderName(string name)
    {
        var normalized = name.Replace("-", string.Empty, StringComparison.Ordinal).Replace("_", string.Empty, StringComparison.Ordinal);
        return normalized.Contains("authorization", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("apikey", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("auth", StringComparison.OrdinalIgnoreCase)
            || normalized.Contains("token", StringComparison.OrdinalIgnoreCase)
            || normalized.EndsWith("key", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed record DirectChat
{
    public DirectChat(DirectChatId id, BotId botId, DateTimeOffset createdAt)
    {
        if (id.IsEmpty) throw new ArgumentException("Direct chat ID is required.", nameof(id));
        if (botId.IsEmpty) throw new ArgumentException("Bot ID is required.", nameof(botId));
        Id = id;
        BotId = botId;
        CreatedAt = createdAt;
    }

    public DirectChatId Id { get; }
    public BotId BotId { get; }
    public DateTimeOffset CreatedAt { get; }
    public static DirectChat Create(BotId botId, DateTimeOffset? now = null) => new(DirectChatId.New(), botId, now ?? DateTimeOffset.UtcNow);
    public static DirectChat Rehydrate(DirectChatId id, BotId botId, DateTimeOffset createdAt) => new(id, botId, createdAt);
}

/// <summary>A long-lived product identity. Its DirectChatId remains stable when its model profile changes.</summary>
public sealed record Bot
{
    private Bot(BotId id, BotProfile profile, ModelProfile modelProfile, DirectChatId directChatId, DateTimeOffset createdAt, BotLifecycleState lifecycleState)
    {
        if (id.IsEmpty) throw new ArgumentException("Bot ID is required.", nameof(id));
        if (directChatId.IsEmpty) throw new ArgumentException("Direct chat ID is required.", nameof(directChatId));
        Id = id;
        Profile = profile ?? throw new ArgumentNullException(nameof(profile));
        ModelProfile = modelProfile ?? throw new ArgumentNullException(nameof(modelProfile));
        DirectChatId = directChatId;
        CreatedAt = createdAt;
        LifecycleState = lifecycleState;
    }

    public BotId Id { get; }
    public BotProfile Profile { get; private init; }
    public ModelProfile ModelProfile { get; private init; }
    public DirectChatId DirectChatId { get; }
    public DateTimeOffset CreatedAt { get; }
    public BotLifecycleState LifecycleState { get; private init; }

    public static Bot Create(BotProfile profile, ModelProfile modelProfile, DateTimeOffset? now = null) =>
        new(BotId.New(), profile, modelProfile, DirectChatId.New(), now ?? DateTimeOffset.UtcNow, BotLifecycleState.Active);

    public static Bot Rehydrate(BotId id, BotProfile profile, ModelProfile modelProfile, DirectChatId directChatId, DateTimeOffset createdAt, BotLifecycleState lifecycleState) =>
        new(id, profile, modelProfile, directChatId, createdAt, lifecycleState);

    public Bot RenameOrEditProfile(string name, string? description = null, string? instructions = null, DateTimeOffset? now = null) =>
        this with { Profile = Profile.Edit(name, description, instructions, now) };

    public Bot EditModelSettings(ProviderConnectionId connectionId, string model, GenerationOptions? generationOptions = null, IReadOnlyDictionary<string, string>? providerOptions = null) =>
        this with { ModelProfile = ModelProfile.WithSettings(connectionId, model, generationOptions, providerOptions) };

    public Bot WithModelProfile(ModelProfile modelProfile)
    {
        ArgumentNullException.ThrowIfNull(modelProfile);
        if (modelProfile.Id != ModelProfile.Id)
            throw new AmiraException(new(AmiraErrorCodes.ModelProfileIdentityMismatch, ErrorCategory.DomainRule, "A Bot model profile identity cannot be replaced."));
        return this with { ModelProfile = modelProfile };
    }
    public Bot Archive() => this with { LifecycleState = BotLifecycleState.Archived };
    public Bot Restore() => this with { LifecycleState = BotLifecycleState.Active };
}

/// <summary>Workspace identity and creation boundary. Bot/DirectChat uniqueness is enforced transactionally by the store.</summary>
public sealed record Workspace(WorkspaceId Id, DateTimeOffset CreatedAt)
{
    public static Workspace Create(WorkspaceId? id = null, DateTimeOffset? now = null) => new(id ?? WorkspaceId.New(), now ?? DateTimeOffset.UtcNow);
    public static Workspace Rehydrate(WorkspaceId id, DateTimeOffset createdAt)
    {
        if (id.IsEmpty) throw new ArgumentException("Workspace ID is required.", nameof(id));
        return new(id, createdAt);
    }
}

public sealed record MessageRevision
{
    private MessageRevision(MessageRevisionId id, MessageId messageId, string content, DateTimeOffset createdAt, MessageRevisionId? replacesRevisionId)
    {
        if (id.IsEmpty) throw new ArgumentException("Message revision ID is required.", nameof(id));
        if (messageId.IsEmpty) throw new ArgumentException("Message ID is required.", nameof(messageId));
        Id = id;
        MessageId = messageId;
        Content = BotProfile.RequireContent(content, nameof(content));
        CreatedAt = createdAt;
        ReplacesRevisionId = replacesRevisionId;
    }

    public MessageRevisionId Id { get; }
    public MessageId MessageId { get; }
    public string Content { get; }
    public DateTimeOffset CreatedAt { get; }
    public MessageRevisionId? ReplacesRevisionId { get; }

    public static MessageRevision Create(MessageId messageId, string content, DateTimeOffset? now = null) => new(MessageRevisionId.New(), messageId, content, now ?? DateTimeOffset.UtcNow, null);
    public static MessageRevision Rehydrate(MessageRevisionId id, MessageId messageId, string content, DateTimeOffset createdAt, MessageRevisionId? replacesRevisionId) => new(id, messageId, content, createdAt, replacesRevisionId);
    public MessageRevision Revise(string content, DateTimeOffset? now = null) => new(MessageRevisionId.New(), MessageId, content, now ?? DateTimeOffset.UtcNow, Id);
}

public sealed record Message
{
    private Message(MessageId id, DirectChatId chatId, MessageAuthor author, MessageRevisionId currentRevisionId, DateTimeOffset createdAt, MessageStatus status)
    {
        if (id.IsEmpty) throw new ArgumentException("Message ID is required.", nameof(id));
        if (chatId.IsEmpty) throw new ArgumentException("Chat ID is required.", nameof(chatId));
        if (currentRevisionId.IsEmpty) throw new ArgumentException("Current revision ID is required.", nameof(currentRevisionId));
        Id = id;
        ChatId = chatId;
        Author = author;
        CurrentRevisionId = currentRevisionId;
        CreatedAt = createdAt;
        Status = status;
    }

    public MessageId Id { get; }
    public DirectChatId ChatId { get; }
    public MessageAuthor Author { get; }
    public MessageRevisionId CurrentRevisionId { get; private init; }
    public DateTimeOffset CreatedAt { get; }
    public MessageStatus Status { get; }

    public static Message Create(MessageId id, DirectChatId chatId, MessageAuthor author, MessageRevision revision, DateTimeOffset? now = null)
    {
        ArgumentNullException.ThrowIfNull(revision);
        if (revision.MessageId != id)
            throw new AmiraException(new(AmiraErrorCodes.RevisionMessageMismatch, ErrorCategory.DomainRule, "The revision does not belong to the message."));
        return new(id, chatId, author, revision.Id, now ?? revision.CreatedAt, MessageStatus.Committed);
    }

    public static Message Rehydrate(MessageId id, DirectChatId chatId, MessageAuthor author, MessageRevisionId currentRevisionId, DateTimeOffset createdAt, MessageStatus status) =>
        new(id, chatId, author, currentRevisionId, createdAt, status);

    public Message ApplyRevision(MessageRevision revision)
    {
        ArgumentNullException.ThrowIfNull(revision);
        if (revision.MessageId != Id || revision.ReplacesRevisionId != CurrentRevisionId)
            throw new AmiraException(new(AmiraErrorCodes.InvalidRevision, ErrorCategory.DomainRule, "The revision must replace the current message revision."));
        return this with { CurrentRevisionId = revision.Id };
    }
}

/// <summary>Content-bearing timeline projection; archive storage may keep Message metadata and revisions separately.</summary>
public sealed record ChatMessage(MessageId Id, DirectChatId ChatId, MessageAuthor Author, MessageRevision Revision, DateTimeOffset CreatedAt, MessageStatus Status)
{
    public static ChatMessage From(Message message, MessageRevision revision)
    {
        ArgumentNullException.ThrowIfNull(message);
        ArgumentNullException.ThrowIfNull(revision);
        if (message.Id != revision.MessageId || message.CurrentRevisionId != revision.Id) throw new ArgumentException("Revision must be the Message's current revision.", nameof(revision));
        return new(message.Id, message.ChatId, message.Author, revision, message.CreatedAt, message.Status);
    }
}

public sealed record TurnUsage
{
    public TurnUsage(int? inputTokens = null, int? outputTokens = null)
    {
        if (inputTokens is < 0) throw new ArgumentOutOfRangeException(nameof(inputTokens));
        if (outputTokens is < 0) throw new ArgumentOutOfRangeException(nameof(outputTokens));
        InputTokens = inputTokens;
        OutputTokens = outputTokens;
    }

    public int? InputTokens { get; }
    public int? OutputTokens { get; }
}

/// <summary>Immutable turn state. Complete, fail, and cancel only accept a Running turn; retry creates a new TurnId.</summary>
public sealed record BotTurn
{
    private BotTurn(BotTurnId id, BotId botId, DirectChatId chatId, IReadOnlyList<MessageId> triggerMessageIds, ModelProfileSnapshot modelProfileSnapshot, int attempt, BotTurnStatus status, DateTimeOffset queuedAt, DateTimeOffset? startedAt, DateTimeOffset? finishedAt, AmiraError? failure, TurnUsage? usage, bool stopRequested, BotTurnId? retryOfTurnId)
    {
        if (id.IsEmpty) throw new ArgumentException("Turn ID is required.", nameof(id));
        if (botId.IsEmpty) throw new ArgumentException("Bot ID is required.", nameof(botId));
        if (chatId.IsEmpty) throw new ArgumentException("Chat ID is required.", nameof(chatId));
        if (attempt <= 0) throw new ArgumentOutOfRangeException(nameof(attempt));
        if ((attempt == 1) != (retryOfTurnId is null)) throw new ArgumentException("Retry lineage must match the attempt number.", nameof(retryOfTurnId));
        if (triggerMessageIds is null || triggerMessageIds.Count == 0) throw new ArgumentException("A turn requires at least one trigger message.", nameof(triggerMessageIds));
        if (triggerMessageIds.Distinct().Count() != triggerMessageIds.Count) throw new ArgumentException("Trigger messages must be unique.", nameof(triggerMessageIds));
        Id = id;
        BotId = botId;
        ChatId = chatId;
        TriggerMessageIds = new ReadOnlyCollection<MessageId>(triggerMessageIds.ToArray());
        ModelProfileSnapshot = modelProfileSnapshot ?? throw new ArgumentNullException(nameof(modelProfileSnapshot));
        Attempt = attempt;
        Status = status;
        QueuedAt = queuedAt;
        StartedAt = startedAt;
        FinishedAt = finishedAt;
        Failure = failure;
        Usage = usage;
        StopRequested = stopRequested;
        RetryOfTurnId = retryOfTurnId;
    }

    public BotTurnId Id { get; }
    public BotId BotId { get; }
    public DirectChatId ChatId { get; }
    public IReadOnlyList<MessageId> TriggerMessageIds { get; }
    public ModelProfileSnapshot ModelProfileSnapshot { get; }
    public int Attempt { get; }
    public BotTurnStatus Status { get; private init; }
    public DateTimeOffset QueuedAt { get; }
    public DateTimeOffset? StartedAt { get; private init; }
    public DateTimeOffset? FinishedAt { get; private init; }
    public AmiraError? Failure { get; private init; }
    public TurnUsage? Usage { get; private init; }
    public bool StopRequested { get; private init; }
    public BotTurnId? RetryOfTurnId { get; private init; }

    public static BotTurn Queue(BotId botId, DirectChatId chatId, IEnumerable<MessageId> triggerMessageIds, ModelProfileSnapshot snapshot, DateTimeOffset? now = null) =>
        new(BotTurnId.New(), botId, chatId, triggerMessageIds?.ToArray() ?? throw new ArgumentNullException(nameof(triggerMessageIds)), snapshot, 1, BotTurnStatus.Queued, now ?? DateTimeOffset.UtcNow, null, null, null, null, false, null);

    public static BotTurn Rehydrate(BotTurnId id, BotId botId, DirectChatId chatId, IEnumerable<MessageId> triggerMessageIds, ModelProfileSnapshot snapshot, int attempt, BotTurnStatus status, DateTimeOffset queuedAt, DateTimeOffset? startedAt, DateTimeOffset? finishedAt, AmiraError? failure, TurnUsage? usage, bool stopRequested, BotTurnId? retryOfTurnId) =>
        new(id, botId, chatId, triggerMessageIds?.ToArray() ?? throw new ArgumentNullException(nameof(triggerMessageIds)), snapshot, attempt, status, queuedAt, startedAt, finishedAt, failure, usage, stopRequested, retryOfTurnId);

    public BotTurn Start(DateTimeOffset? now = null)
    {
        EnsureStatus(BotTurnStatus.Queued);
        if (StopRequested)
            throw new AmiraException(new(AmiraErrorCodes.TurnStopRequested, ErrorCategory.DomainRule, "A stop-requested turn cannot start."));
        return this with { Status = BotTurnStatus.Running, StartedAt = now ?? DateTimeOffset.UtcNow };
    }

    public BotTurn Complete(TurnUsage? usage = null, DateTimeOffset? now = null)
    {
        EnsureStatus(BotTurnStatus.Running);
        if (StopRequested)
            throw new AmiraException(new(AmiraErrorCodes.TurnStopRequested, ErrorCategory.DomainRule, "A stop-requested turn must be cancelled."));
        return this with { Status = BotTurnStatus.Completed, FinishedAt = now ?? DateTimeOffset.UtcNow, Usage = usage };
    }

    public BotTurn Fail(AmiraError failure, DateTimeOffset? now = null)
    {
        EnsureStatus(BotTurnStatus.Running);
        return this with { Status = BotTurnStatus.Failed, FinishedAt = now ?? DateTimeOffset.UtcNow, Failure = failure };
    }

    public BotTurn RequestStop() => Status is BotTurnStatus.Queued or BotTurnStatus.Running
        ? this with { StopRequested = true }
        : throw new AmiraException(new(AmiraErrorCodes.InvalidTurnTransition, ErrorCategory.DomainRule, "Only an active turn can be stopped."));

    public BotTurn Cancel(DateTimeOffset? now = null)
    {
        if (Status is not (BotTurnStatus.Queued or BotTurnStatus.Running))
            throw new AmiraException(new(AmiraErrorCodes.InvalidTurnTransition, ErrorCategory.DomainRule, "Only an active turn can be cancelled."));
        return this with { Status = BotTurnStatus.Cancelled, FinishedAt = now ?? DateTimeOffset.UtcNow, StopRequested = true };
    }

    public BotTurn Retry(DateTimeOffset? now = null)
    {
        if (Status is not (BotTurnStatus.Failed or BotTurnStatus.Cancelled))
            throw new AmiraException(new(AmiraErrorCodes.InvalidTurnTransition, ErrorCategory.DomainRule, "Only a failed or cancelled turn can be retried."));
        return new(BotTurnId.New(), BotId, ChatId, TriggerMessageIds, ModelProfileSnapshot, Attempt + 1, BotTurnStatus.Queued, now ?? DateTimeOffset.UtcNow, null, null, null, null, false, Id);
    }

    private void EnsureStatus(BotTurnStatus expected)
    {
        if (Status != expected)
            throw new AmiraException(new(AmiraErrorCodes.InvalidTurnTransition, ErrorCategory.DomainRule, "The turn cannot transition from its current state."));
    }
}
