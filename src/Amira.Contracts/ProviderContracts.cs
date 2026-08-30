using Amira.Domain;
using Amira.Errors;
using System.Diagnostics;

namespace Amira.Contracts;

public enum ModelMessageRole { User, Assistant }

/// <summary>One provider-neutral message in a temporary Context Projection.</summary>
public sealed record ModelMessage
{
    public ModelMessage(ModelMessageRole role, string content)
    {
        Role = role;
        Content = ContractValidation.RequireContent(content, nameof(content));
    }

    public ModelMessageRole Role { get; }
    public string Content { get; }
}

/// <summary>
/// Provider-neutral input. Adapters own protocol-specific serialization and must not treat any remote conversation ID as state.
/// Typed IDs are the safe correlation fields; Metadata is local-only context and is not forwarded unless an adapter explicitly opts in.
/// </summary>
public sealed record ModelRequest
{
    public ModelRequest(WorkspaceId workspaceId, BotId botId, DirectChatId directChatId, BotTurnId botTurnId, ModelProfileSnapshot modelProfile, IEnumerable<ModelMessage> messages, string? systemInstruction = null, IReadOnlyDictionary<string, string>? metadata = null)
    {
        if (workspaceId.IsEmpty) throw new ArgumentException("Workspace ID is required.", nameof(workspaceId));
        if (botId.IsEmpty) throw new ArgumentException("Bot ID is required.", nameof(botId));
        if (directChatId.IsEmpty) throw new ArgumentException("Direct chat ID is required.", nameof(directChatId));
        if (botTurnId.IsEmpty) throw new ArgumentException("Bot turn ID is required.", nameof(botTurnId));
        WorkspaceId = workspaceId;
        BotId = botId;
        DirectChatId = directChatId;
        BotTurnId = botTurnId;
        ModelProfile = modelProfile ?? throw new ArgumentNullException(nameof(modelProfile));
        ArgumentNullException.ThrowIfNull(messages);
        Messages = messages.ToArray();
        if (Messages.Count == 0) throw new ArgumentException("A model request requires at least one message.", nameof(messages));
        SystemInstruction = string.IsNullOrEmpty(systemInstruction) ? null : systemInstruction;
        Metadata = DomainModelHelpers.FreezeDictionary(metadata ?? new Dictionary<string, string>(), nameof(metadata));
    }

    public WorkspaceId WorkspaceId { get; }
    public BotId BotId { get; }
    public DirectChatId DirectChatId { get; }
    public BotTurnId BotTurnId { get; }
    public ModelProfileSnapshot ModelProfile { get; }
    public IReadOnlyList<ModelMessage> Messages { get; }
    public string? SystemInstruction { get; }
    public IReadOnlyDictionary<string, string> Metadata { get; }

    public void ValidateConnection(ProviderConnection connection)
    {
        ArgumentNullException.ThrowIfNull(connection);
        if (connection.Id != ModelProfile.ConnectionId || connection.Protocol != ModelProfile.Protocol)
            throw new AmiraException(new(
                AmiraErrorCodes.SnapshotMismatch,
                ErrorCategory.DomainRule,
                "The provider connection does not match the saved model profile snapshot."));
    }
}

/// <summary>Provider usage reported after text deltas; values are optional when a provider omits them.</summary>
public sealed record ProviderUsage
{
    public ProviderUsage(int? inputTokens = null, int? outputTokens = null)
    {
        if (inputTokens is < 0) throw new ArgumentOutOfRangeException(nameof(inputTokens));
        if (outputTokens is < 0) throw new ArgumentOutOfRangeException(nameof(outputTokens));
        InputTokens = inputTokens;
        OutputTokens = outputTokens;
    }

    public int? InputTokens { get; }
    public int? OutputTokens { get; }
}

/// <summary>Normalized provider stream. A successful stream is Started, zero or more TextDelta, optional Usage, then Completed.</summary>
public abstract record ModelStreamEvent
{
    private ModelStreamEvent() { }

    public sealed record Started : ModelStreamEvent;
    public sealed record TextDelta : ModelStreamEvent
    {
        public TextDelta(string text) => Text = ContractValidation.RequireContent(text, nameof(text));
        public string Text { get; }
    }
    public sealed record Usage : ModelStreamEvent
    {
        public Usage(ProviderUsage value) => Value = value ?? throw new ArgumentNullException(nameof(value));
        public ProviderUsage Value { get; }
    }
    public sealed record Completed : ModelStreamEvent;
}

/// <summary>
/// Model invocation seam. Adapters may ignore unknown upstream events, but successful output must emit exactly one Started and one Completed.
/// Provider failures surface as a Provider-category <see cref="AmiraException"/> and cancellation as <see cref="OperationCanceledException"/>.
/// </summary>
public interface IModelProvider
{
    ProviderProtocol Protocol { get; }
    /// <summary>Connection ID and protocol must match the request's ModelProfile snapshot; connection carries endpoint/credential references only.</summary>
    IAsyncEnumerable<ModelStreamEvent> StreamAsync(ProviderConnection connection, ModelRequest request, CancellationToken cancellationToken = default);
}

/// <summary>Opaque lease identity supplied by the store; workers must present the same token to mutate a claimed turn.</summary>
public readonly record struct TurnClaimToken : IAmiraId
{
    public TurnClaimToken(string value) => Value = ContractValidation.RequireIdentifier(value, nameof(value));
    public string Value { get; }
    public bool IsEmpty => string.IsNullOrWhiteSpace(Value);
    public static TurnClaimToken New() => new(Guid.NewGuid().ToString("N"));
    public override string ToString() => Value ?? string.Empty;
}

/// <summary>A turn plus its opaque store lease. A stale worker's token must be rejected by the store.</summary>
public sealed record ClaimedTurn
{
    public ClaimedTurn(BotTurn turn, TurnClaimToken claimToken, ActivityContext parentActivityContext = default)
    {
        Turn = turn ?? throw new ArgumentNullException(nameof(turn));
        if (claimToken.IsEmpty) throw new ArgumentException("A claim token is required.", nameof(claimToken));
        ClaimToken = claimToken;
        ParentActivityContext = parentActivityContext;
    }

    public BotTurn Turn { get; }
    public TurnClaimToken ClaimToken { get; }
    /// <summary>Optional W3C trace parent persisted as execution metadata with the turn.</summary>
    public ActivityContext ParentActivityContext { get; }
}

/// <summary>Deep persistence seam for chat use cases. Implementations must make each operation atomic.</summary>
public interface IChatStore : ITurnReader
{
    /// <summary>Commits the Human Message and queues its first BotTurn in one transaction.</summary>
    ValueTask<QueuedMessageResult> CommitHumanMessageAndQueueTurnAsync(HumanMessageCommand command, CancellationToken cancellationToken = default);

    /// <summary>Atomically claims the next queued turn for a Bot; null means no turn was available or another worker won.</summary>
    ValueTask<ClaimedTurn?> TryClaimNextTurnAsync(BotId botId, CancellationToken cancellationToken = default);

    /// <summary>Atomically commits the completed assistant Message and Completed turn, or commits neither.</summary>
    ValueTask CompleteTurnAsync(CompleteTurnCommand command, TurnClaimToken claimToken, CancellationToken cancellationToken = default);

    /// <summary>Persists a sanitized failure and Failed state without removing the Human trigger.</summary>
    ValueTask FailTurnAsync(BotTurnId turnId, TurnClaimToken claimToken, AmiraError failure, CancellationToken cancellationToken = default);

    /// <summary>
    /// Claim-authoritatively cancels a Running turn after its provider enumerator has exited.
    /// The same claim token must still own the turn.
    /// </summary>
    ValueTask CancelClaimedTurnAsync(BotTurnId turnId, TurnClaimToken claimToken, CancellationToken cancellationToken = default);

    /// <summary>Durably records a stop request and, when applicable, the Cancelled state.</summary>
    ValueTask RequestStopAsync(BotTurnId turnId, CancellationToken cancellationToken = default);

    /// <summary>
    /// Explicit startup recovery. Orphaned stop-requested turns become Cancelled; other orphaned Running turns return to Queued.
    /// Hosts must call this only when no worker from the previous process remains active.
    /// </summary>
    ValueTask RecoverInterruptedTurnsAsync(CancellationToken cancellationToken = default);

    /// <summary>Creates a new queued attempt that references the original trigger IDs, retains its trace parent, and does not insert another Human Message.</summary>
    ValueTask<BotTurn> RetryTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default);

    ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default);
}

/// <summary>Deep workspace lifecycle seam. Creating a Bot and its unique DirectChat is one atomic operation.</summary>
public interface IWorkspaceStore
{
    ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default);
    ValueTask<Bot?> GetBotAsync(BotId botId, CancellationToken cancellationToken = default);
    ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default);
    ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default);
    ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default);
    ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default);
    ValueTask SaveProviderConnectionAsync(ProviderConnection connection, CancellationToken cancellationToken = default);
    ValueTask<ProviderConnection?> GetProviderConnectionAsync(ProviderConnectionId connectionId, CancellationToken cancellationToken = default);
    ValueTask<IReadOnlyList<ProviderConnection>> ListProviderConnectionsAsync(CancellationToken cancellationToken = default);
}

public sealed record CreateBotCommand
{
    public CreateBotCommand(BotProfile profile, ModelProfile modelProfile)
    {
        Profile = profile ?? throw new ArgumentNullException(nameof(profile));
        ModelProfile = modelProfile ?? throw new ArgumentNullException(nameof(modelProfile));
    }

    public BotProfile Profile { get; }
    public ModelProfile ModelProfile { get; }
}

public sealed record HumanMessageCommand
{
    public HumanMessageCommand(DirectChatId chatId, string content, BotId botId, ModelProfileSnapshot modelProfileSnapshot, ActivityContext parentActivityContext = default)
    {
        if (chatId == default)
            throw new AmiraException(new(AmiraErrorCodes.ChatRequired, ErrorCategory.Input, "A chat is required."));
        if (botId == default)
            throw new AmiraException(new(AmiraErrorCodes.BotRequired, ErrorCategory.Input, "A Bot is required."));
        ArgumentNullException.ThrowIfNull(content);
        if (string.IsNullOrWhiteSpace(content))
            throw new AmiraException(new(AmiraErrorCodes.ContentRequired, ErrorCategory.Input, "Message content is required."));
        ChatId = chatId;
        Content = content;
        BotId = botId;
        ModelProfileSnapshot = modelProfileSnapshot ?? throw new ArgumentNullException(nameof(modelProfileSnapshot));
        ParentActivityContext = parentActivityContext;
    }

    public DirectChatId ChatId { get; }
    public string Content { get; }
    public BotId BotId { get; }
    public ModelProfileSnapshot ModelProfileSnapshot { get; }
    /// <summary>Optional W3C trace parent to persist with the queued turn.</summary>
    public ActivityContext ParentActivityContext { get; }
}

public sealed record QueuedMessageResult
{
    public QueuedMessageResult(Message message, MessageRevision revision, BotTurn turn)
    {
        Message = message ?? throw new ArgumentNullException(nameof(message));
        Revision = revision ?? throw new ArgumentNullException(nameof(revision));
        Turn = turn ?? throw new ArgumentNullException(nameof(turn));
        if (Message.Id != Revision.MessageId) throw new ArgumentException("Revision must belong to Message.", nameof(revision));
        if (!Turn.TriggerMessageIds.Contains(Message.Id)) throw new ArgumentException("Turn must reference the committed Human Message.", nameof(turn));
    }

    public Message Message { get; }
    public MessageRevision Revision { get; }
    public BotTurn Turn { get; }
}

internal static class DomainModelHelpers
{
    public static IReadOnlyDictionary<string, string> FreezeDictionary(IReadOnlyDictionary<string, string> source, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(source, parameterName);
        var copy = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var pair in source)
        {
            var key = ContractValidation.RequireText(pair.Key, nameof(pair.Key));
            copy[key] = pair.Value ?? throw new ArgumentException("Dictionary values cannot be null.", parameterName);
        }

        return new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(copy);
    }
}

internal static class ContractValidation
{
    public static string RequireIdentifier(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (string.IsNullOrWhiteSpace(value))
            throw new AmiraException(new(AmiraErrorCodes.InvalidIdentifier, ErrorCategory.Input, "An identifier value is required."));
        return value.Trim();
    }

    public static string RequireText(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (string.IsNullOrWhiteSpace(value))
            throw new AmiraException(new(AmiraErrorCodes.TextRequired, ErrorCategory.Input, "A text value is required."));
        return value.Trim();
    }

    public static string RequireContent(string value, string parameterName)
    {
        ArgumentNullException.ThrowIfNull(value, parameterName);
        if (value.Length == 0)
            throw new AmiraException(new(AmiraErrorCodes.ContentRequired, ErrorCategory.Input, "Content is required."));
        return value;
    }
}

public sealed record CompleteTurnCommand
{
    public CompleteTurnCommand(BotTurn turn, string assistantContent, DateTimeOffset? completedAt = null, TurnUsage? usage = null)
    {
        Turn = turn ?? throw new ArgumentNullException(nameof(turn));
        ArgumentException.ThrowIfNullOrWhiteSpace(assistantContent, nameof(assistantContent));
        if (Turn.Status != BotTurnStatus.Running) throw new ArgumentException("Only a Running turn can be completed.", nameof(turn));
        AssistantContent = assistantContent;
        CompletedAt = completedAt;
        Usage = usage;
    }

    public BotTurn Turn { get; }
    public string AssistantContent { get; }
    public DateTimeOffset? CompletedAt { get; }
    /// <summary>Usage reported for this Running turn and committed atomically with its assistant reply.</summary>
    public TurnUsage? Usage { get; }
}
