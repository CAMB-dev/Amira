using Amira.Client.Composition.Windows;
using Amira.Contracts;
using Amira.Domain;
using Amira.Runtime;

namespace Amira.Client.WinUI;

public interface IClientSession : IAsyncDisposable
{
    WorkspaceId WorkspaceId { get; }
    ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default);
    ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default);
    ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default);
    ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default);
    ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default);
    ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default);
    ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default);
    ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default);
    ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default);
    ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default);
    ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default);
    ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default);
    ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default);
}

public sealed class WindowsClientSession(WindowsClientHost host) : IClientSession
{
    private WindowsClientHost? _host = host ?? throw new ArgumentNullException(nameof(host));
    private WindowsClientHost Host => _host ?? throw new ObjectDisposedException(nameof(WindowsClientSession));
    public WorkspaceId WorkspaceId => Host.WorkspaceId;
    public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) => Host.ListBotsAsync(cancellationToken);
    public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) => Host.ListConnectionsAsync(cancellationToken);
    public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => Host.CreateProviderConnectionAsync(protocol, displayName, baseUrl, secret, defaultModel, null, enabled, cancellationToken);
    public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => Host.UpdateProviderConnectionAsync(current, displayName, baseUrl, replacementSecret, defaultModel, current.ExtraHeaders, enabled, cancellationToken);
    public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => Host.CreateBotAsync(command, cancellationToken);
    public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => Host.UpdateBotAsync(bot, cancellationToken);
    public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => Host.ArchiveBotAsync(botId, cancellationToken);
    public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => Host.RestoreBotAsync(botId, cancellationToken);
    public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) => Host.LoadTimelineAsync(chatId, cancellationToken);
    public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) => Host.QueryTurnsAsync(query, cancellationToken);
    public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => Host.SendAsync(botId, content, cancellationToken);
    public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => Host.RetryAsync(turnId, cancellationToken);
    public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => Host.StopTurnAsync(turnId, cancellationToken);
    public async ValueTask DisposeAsync()
    {
        WindowsClientHost? host = Interlocked.Exchange(ref _host, null);
        if (host is not null) await host.StopAsync();
    }
}
