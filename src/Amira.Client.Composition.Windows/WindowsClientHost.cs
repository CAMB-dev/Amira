using System.Diagnostics;
using Amira.Contracts;
using Amira.Credentials.Windows;
using Amira.Domain;
using Amira.Errors;
using Amira.Observability;
using Amira.Persistence.Sqlite;
using Amira.Providers;
using Amira.Runtime;
using Microsoft.Extensions.Logging;

namespace Amira.Client.Composition.Windows;

/// <summary>UI-framework-agnostic Windows composition root and durable client lifecycle facade.</summary>
public sealed class WindowsClientHost : IAsyncDisposable
{
    private readonly SemaphoreSlim _operationGate = new(1, 1);
    private readonly SqliteAmiraStore _store;
    private readonly ProviderTransport _transport;
    private readonly ILoggerFactory _loggerFactory;
    private readonly ActivityListener _activityListener;
    private readonly WindowsHostMeterFactory _meterFactory;
    private readonly SingleInstanceLease _lease;
    private readonly BotWorkerRegistry _workers;
    private readonly BasicChatRuntime _runtime;
    private readonly TaskCompletionSource _stopped = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly ProviderConnectionService _connections;
    private bool _stopping;

    private WindowsClientHost(WorkspaceId workspaceId, string logsDirectory, SqliteAmiraStore store, ProviderTransport transport,
        ILoggerFactory loggerFactory, ActivityListener activityListener, WindowsHostMeterFactory meterFactory,
        SingleInstanceLease lease, BotWorkerRegistry workers, BasicChatRuntime runtime,
        ProviderConnectionService connections)
    {
        WorkspaceId = workspaceId;
        LogsDirectory = logsDirectory;
        _store = store;
        _transport = transport;
        _loggerFactory = loggerFactory;
        _activityListener = activityListener;
        _meterFactory = meterFactory;
        _lease = lease;
        _workers = workers;
        _runtime = runtime;
        _connections = connections;
    }

    public WorkspaceId WorkspaceId { get; }
    public string LogsDirectory { get; }

    public static async ValueTask<WindowsClientHost> StartAsync(IChatRuntimeEventSink sink, string? rootDirectory = null, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(sink);
        SingleInstanceLease? lease = null;
        ILoggerFactory? loggerFactory = null;
        ActivityListener? activityListener = null;
        WindowsHostMeterFactory? meterFactory = null;
        ProviderTransport? transport = null;
        SqliteAmiraStore? store = null;
        BotWorkerRegistry? workers = null;
        try
        {
            ClientPaths paths = ClientPaths.Create(rootDirectory);
            lease = await SingleInstanceLease.AcquireAsync(paths.DatabasePath, cancellationToken).ConfigureAwait(false);
            loggerFactory = AmiraLogging.CreateJsonFileLoggerFactory(new JsonFileLoggingOptions { DirectoryPath = paths.LogsDirectory });
            activityListener = CreateRuntimeActivityListener();
            meterFactory = new WindowsHostMeterFactory();
            WorkspaceId workspaceId = await new WorkspaceIdentityStore(paths.WorkspaceIdentityPath).LoadOrCreateAsync(cancellationToken).ConfigureAwait(false);
            var vault = new WindowsCredentialVault();
            store = new SqliteAmiraStore(paths.DatabasePath);
            await store.InitializeAsync(cancellationToken).ConfigureAwait(false);
            transport = ProviderTransport.CreateSecureDefault();
            var registry = new ProviderRegistry();
            registry.Register(new OpenAiChatCompatibleProvider(transport, vault));
            registry.Register(new OpenAiResponsesProvider(transport, vault));
            registry.Register(new AnthropicMessagesProvider(transport, vault));
            registry.Freeze();
            var runtime = new BasicChatRuntime(store, store, registry, logger: loggerFactory.CreateLogger<BasicChatRuntime>(), meterFactory: meterFactory);
            await runtime.RecoverInterruptedTurnsAsync(cancellationToken).ConfigureAwait(false);
            workers = new BotWorkerRegistry(runtime, workspaceId, sink, loggerFactory.CreateLogger<BotWorkerRegistry>());
            IReadOnlyList<Bot> bots = await store.ListBotsAsync(cancellationToken).ConfigureAwait(false);
            foreach (Bot bot in bots.Where(bot => bot.LifecycleState == BotLifecycleState.Active)) workers.Register(bot.Id);
            return new WindowsClientHost(workspaceId, paths.LogsDirectory, store, transport, loggerFactory, activityListener, meterFactory, lease, workers, runtime, new ProviderConnectionService(vault, store, loggerFactory.CreateLogger<ProviderConnectionService>()));
        }
        catch (Exception original)
        {
            ILogger? logger = loggerFactory?.CreateLogger<WindowsClientHost>();
            if (workers is not null)
            {
                try { await workers.DisposeAsync().ConfigureAwait(false); }
                catch (Exception cleanup) { logger?.LogError("Startup cleanup failed: {Code} {ExceptionType}", AmiraErrorCodes.BotWorkerFailed, cleanup.GetType().Name); }
            }
            try { transport?.Dispose(); }
            catch (Exception cleanup) { logger?.LogError("Startup cleanup failed: {Code} {ExceptionType}", AmiraErrorCodes.ClientInstanceFailed, cleanup.GetType().Name); }
            try { store?.Dispose(); }
            catch (Exception cleanup) { logger?.LogError("Startup cleanup failed: {Code} {ExceptionType}", AmiraErrorCodes.PersistenceFailed, cleanup.GetType().Name); }
            meterFactory?.Dispose();
            try { loggerFactory?.Dispose(); }
            catch { }
            activityListener?.Dispose();
            try { lease?.Dispose(); }
            catch { }
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(original).Throw();
            throw;
        }
    }

    public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.ListBotsAsync(token), cancellationToken);

    public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.ListProviderConnectionsAsync(token), cancellationToken);

    public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl,
        string secret, string? defaultModel = null, IReadOnlyDictionary<string, string>? extraHeaders = null, bool enabled = true,
        CancellationToken cancellationToken = default) =>
        OperateAsync(token => _connections.CreateAsync(protocol, displayName, baseUrl, secret, defaultModel, extraHeaders, enabled, token), cancellationToken);

    public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl,
        string? replacementSecret, string? defaultModel, IReadOnlyDictionary<string, string> extraHeaders, bool enabled,
        CancellationToken cancellationToken = default) =>
        OperateAsync(token => _connections.UpdateAsync(current, displayName, baseUrl, replacementSecret, defaultModel, extraHeaders, enabled, token), cancellationToken);

    public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) =>
        OperateAsync(async token =>
        {
            Bot bot = await _store.CreateBotAsync(command, token).ConfigureAwait(false);
            if (bot.LifecycleState == BotLifecycleState.Active) _workers.Register(bot.Id);
            return bot;
        }, cancellationToken);

    public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.UpdateBotAsync(bot, token), cancellationToken);

    public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) =>
        OperateAsync(async token =>
        {
            Bot bot = await _store.ArchiveBotAsync(botId, token).ConfigureAwait(false);
            _ = await _workers.UnregisterAsync(bot.Id).ConfigureAwait(false);
            return bot;
        }, cancellationToken);

    public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) =>
        OperateAsync(async token =>
        {
            Bot bot = await _store.RestoreBotAsync(botId, token).ConfigureAwait(false);
            if (bot.LifecycleState == BotLifecycleState.Active) _workers.EnsureRegistered(bot.Id);
            return bot;
        }, cancellationToken);

    public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.LoadTimelineAsync(chatId, token), cancellationToken);

    public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.QueryTurnsAsync(query, token), cancellationToken);

    public ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
        OperateAsync(token => _store.GetTurnAsync(turnId, token), cancellationToken);

    public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) =>
        OperateAsync(async token =>
        {
            QueuedMessageResult result = await _runtime.QueueHumanMessageAsync(WorkspaceId, botId, content, token).ConfigureAwait(false);
            _workers.Wake(botId);
            return result;
        }, cancellationToken);

    public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
        OperateAsync(async token =>
        {
            BotTurn turn = await _runtime.RetryAsync(turnId, token).ConfigureAwait(false);
            _workers.Wake(turn.BotId);
            return turn;
        }, cancellationToken);

    public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
        OperateAsync(token => _runtime.StopAsync(turnId, token), cancellationToken);

    public async ValueTask StopAsync()
    {
        Task? existingStop;
        await _operationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            existingStop = _stopping ? _stopped.Task : null;
            if (!_stopping) _stopping = true;
        }
        finally { _operationGate.Release(); }
        if (existingStop is not null)
        {
            await existingStop.ConfigureAwait(false);
            return;
        }

        Exception? failure = null;
        try
        {
            try { await _workers.DisposeAsync().ConfigureAwait(false); }
            catch (Exception exception) { failure = exception; }
            try { _transport.Dispose(); } catch (Exception exception) { failure ??= exception; }
            try { _store.Dispose(); } catch (Exception exception) { failure ??= exception; }
            try { _meterFactory.Dispose(); } catch (Exception exception) { failure ??= exception; }
            try { _loggerFactory.Dispose(); } catch (Exception exception) { failure ??= exception; }
            try { _activityListener.Dispose(); } catch (Exception exception) { failure ??= exception; }
            try { _lease.Dispose(); } catch (Exception exception) { failure ??= exception; }
        }
        finally
        {
            if (failure is null) _stopped.TrySetResult();
            else _stopped.TrySetException(failure);
        }
        await _stopped.Task.ConfigureAwait(false);
    }

    public ValueTask DisposeAsync() => StopAsync();

    private async ValueTask<T> OperateAsync<T>(Func<CancellationToken, ValueTask<T>> operation, CancellationToken cancellationToken)
    {
        await _operationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_stopping) throw Stopped();
            return await operation(cancellationToken).ConfigureAwait(false);
        }
        finally { _operationGate.Release(); }
    }

    private static AmiraException Stopped() => new(new(AmiraErrorCodes.ClientHostStopped, ErrorCategory.Concurrency, "The client host is stopping or has stopped."));

    private static ActivityListener CreateRuntimeActivityListener()
    {
        var listener = new ActivityListener
        {
            ShouldListenTo = static source => source.Name == AmiraTelemetry.ActivitySourceName,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.PropagationData,
            SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.PropagationData,
        };
        ActivitySource.AddActivityListener(listener);
        return listener;
    }
}
