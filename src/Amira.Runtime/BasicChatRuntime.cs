using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Collections.Concurrent;
using System.Runtime.CompilerServices;
using System.Runtime.ExceptionServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Amira.Runtime;

/// <summary>Small orchestration service for direct chat. Scheduling remains the store's responsibility.</summary>
public sealed class BasicChatRuntime
{
    private readonly IChatStore _chatStore;
    private readonly IWorkspaceStore _workspaceStore;
    private readonly ProviderRegistry _providers;
    private readonly ContextBuilder _contextBuilder;
    private readonly int _characterBudget;
    private readonly ILogger _logger;
    private readonly RuntimeTelemetry _telemetry;
    private readonly ConcurrentDictionary<BotTurnId, CancellationTokenSource> _activeTurns = new();

    public BasicChatRuntime(
        IChatStore chatStore,
        IWorkspaceStore workspaceStore,
        ProviderRegistry providers,
        int characterBudget = 32_000,
        ILogger? logger = null,
        IMeterFactory? meterFactory = null)
    {
        _chatStore = chatStore ?? throw new ArgumentNullException(nameof(chatStore));
        _workspaceStore = workspaceStore ?? throw new ArgumentNullException(nameof(workspaceStore));
        _providers = providers ?? throw new ArgumentNullException(nameof(providers));
        _contextBuilder = new ContextBuilder(chatStore);
        if (characterBudget <= 0) throw new ArgumentOutOfRangeException(nameof(characterBudget));
        _characterBudget = characterBudget;
        _logger = logger ?? NullLogger.Instance;
        _telemetry = new RuntimeTelemetry(meterFactory);
    }

    public async ValueTask<QueuedMessageResult> QueueHumanMessageAsync(
        WorkspaceId workspaceId,
        BotId botId,
        string content,
        CancellationToken cancellationToken = default)
    {
        if (workspaceId.IsEmpty)
            throw new AmiraException(Error(AmiraErrorCodes.WorkspaceRequired, ErrorCategory.Input, "A workspace is required."));
        ArgumentNullException.ThrowIfNull(content);
        if (string.IsNullOrWhiteSpace(content))
            throw new AmiraException(Error(AmiraErrorCodes.ContentRequired, ErrorCategory.Input, "Message content is required."));
        Bot bot = await _workspaceStore.GetBotAsync(botId, cancellationToken).ConfigureAwait(false)
            ?? throw new AmiraException(Error(AmiraErrorCodes.BotNotFound, ErrorCategory.NotFound, "The requested Bot was not found."));
        if (bot.LifecycleState != BotLifecycleState.Active)
            throw new AmiraException(Error(AmiraErrorCodes.BotInactive, ErrorCategory.DomainRule, "The requested Bot is not active."));

        ProviderConnection connection = await _workspaceStore.GetProviderConnectionAsync(bot.ModelProfile.ConnectionId, cancellationToken).ConfigureAwait(false)
            ?? throw new AmiraException(Error(AmiraErrorCodes.ConnectionNotFound, ErrorCategory.NotFound, "The Bot provider connection was not found."));
        ModelProfileSnapshot snapshot = bot.ModelProfile.Snapshot(connection.Protocol);
        ActivityContext ambientParent = Activity.Current?.Context ?? default;
        using RuntimeTelemetryScope telemetry = RuntimeTelemetry.StartMessageCommit(bot, ambientParent);
        try
        {
            QueuedMessageResult result = await _chatStore.CommitHumanMessageAndQueueTurnAsync(
                new HumanMessageCommand(bot.DirectChatId, content, bot.Id, snapshot, telemetry.Context), cancellationToken).ConfigureAwait(false);
            RuntimeLog.MessageCommitted(_logger, bot.Id.Value);
            RuntimeLog.TurnQueued(_logger, result.Turn.Id.Value, bot.Id.Value);
            telemetry.Success();
            return result;
        }
        catch (OperationCanceledException)
        {
            telemetry.Cancelled();
            throw;
        }
        catch (AmiraException exception)
        {
            telemetry.Failure(exception.Code);
            throw;
        }
        catch
        {
            telemetry.Failure(AmiraTelemetry.ErrorCodes.UnexpectedException);
            throw;
        }
    }

    /// <summary>Claims one queued turn. A null claim produces no events.</summary>
    public async IAsyncEnumerable<ChatRuntimeEvent> ExecuteNextAsync(
        WorkspaceId workspaceId,
        BotId botId,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ClaimedTurn? claimed = await _chatStore.TryClaimNextTurnAsync(botId, cancellationToken).ConfigureAwait(false);
        if (claimed is null) yield break;
        RuntimeLog.TurnClaimed(_logger, claimed.Turn.Id.Value, claimed.Turn.BotId.Value);
        await foreach (ChatRuntimeEvent item in ExecuteClaimedAsync(workspaceId, claimed, cancellationToken).ConfigureAwait(false))
            yield return item;
    }

    /// <summary>Executes a store claim. The claim token is used for every terminal mutation.</summary>
    public async IAsyncEnumerable<ChatRuntimeEvent> ExecuteClaimedAsync(
        WorkspaceId workspaceId,
        ClaimedTurn claimed,
        [EnumeratorCancellation] CancellationToken externalCancellation = default)
    {
        ArgumentNullException.ThrowIfNull(claimed);
        BotTurn turn = claimed.Turn;
        using CancellationTokenSource linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(externalCancellation);
        if (!_activeTurns.TryAdd(turn.Id, linkedCancellation))
        {
            yield return FailureEvent(turn, Error(AmiraErrorCodes.TurnAlreadyRunning, ErrorCategory.Concurrency, "This turn is already running."));
            yield break;
        }

        using RuntimeTelemetryScope turnTelemetry = RuntimeTelemetry.StartTurnExecution(turn, claimed.ParentActivityContext, _logger);
        bool terminalSettled = false;
        try
        {
            if (turn.StopRequested || linkedCancellation.IsCancellationRequested)
            {
                await CancelAfterProviderExitAsync(turn, claimed.ClaimToken).ConfigureAwait(false);
                terminalSettled = true;
                turnTelemetry.Cancelled();
                yield return new ChatRuntimeEvent.Cancelled(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model);
                yield break;
            }

            Bot? bot = await _workspaceStore.GetBotAsync(turn.BotId, externalCancellation).ConfigureAwait(false);
            if (bot is null)
            {
                AmiraError failure = Error(AmiraErrorCodes.BotNotFound, ErrorCategory.NotFound, "The requested Bot was not found.");
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }
            if (bot.LifecycleState != BotLifecycleState.Active)
            {
                AmiraError failure = Error(AmiraErrorCodes.BotInactive, ErrorCategory.DomainRule, "The requested Bot is not active.");
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }

            ProviderConnection? connection = await _workspaceStore.GetProviderConnectionAsync(turn.ModelProfileSnapshot.ConnectionId, externalCancellation).ConfigureAwait(false);
            if (connection is null)
            {
                AmiraError failure = Error(AmiraErrorCodes.ConnectionNotFound, ErrorCategory.NotFound, "The Bot provider connection was not found.");
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }
            if (!connection.Enabled)
            {
                AmiraError failure = Error(AmiraErrorCodes.ConnectionDisabled, ErrorCategory.Configuration, "The Bot provider connection is disabled.");
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }
            if (connection.Protocol != turn.ModelProfileSnapshot.Protocol || connection.Id != turn.ModelProfileSnapshot.ConnectionId)
            {
                AmiraError failure = Error(AmiraErrorCodes.SnapshotMismatch, ErrorCategory.DomainRule, "The saved model snapshot does not match its provider connection.");
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }

            ContextBuildResult? context = null;
            AmiraException? contextException = null;
            try
            {
                context = await _contextBuilder.BuildAsync(workspaceId, bot, turn, _characterBudget, externalCancellation).ConfigureAwait(false);
                RuntimeLog.ContextBuilt(_logger, turn.Id.Value, context.Diagnostics.IncludedMessageCount, context.Diagnostics.DroppedMessageCount, context.Diagnostics.IncludedCharacters);
            }
            catch (AmiraException exception)
            {
                contextException = exception;
            }
            if (contextException is not null)
            {
                AmiraError failure = contextException.Error;
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }

            IModelProvider? provider = null;
            AmiraException? providerException = null;
            try { provider = _providers.Get(turn.ModelProfileSnapshot.Protocol); }
            catch (AmiraException exception)
            {
                providerException = exception;
            }
            if (providerException is not null)
            {
                AmiraError failure = providerException.Error;
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
                yield break;
            }
            CancellationToken runCancellation = linkedCancellation.Token;
            using RuntimeTelemetryScope requestTelemetry = _telemetry.StartProviderRequest(turn, claimed.ParentActivityContext, _logger);
            yield return new ChatRuntimeEvent.Started(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model);
            bool started = false;
            bool completed = false;
            bool usageSeen = false;
            var response = new System.Text.StringBuilder();
            ProviderUsage? usage = null;

            Exception? streamError = null;
            IAsyncEnumerator<ModelStreamEvent>? enumerator = null;
            try
            {
                enumerator = provider!.StreamAsync(connection, context!.Request, runCancellation).GetAsyncEnumerator(runCancellation);
            }
            catch (Exception exception)
            {
                streamError = exception;
            }
            if (streamError is null)
            {
                await using (enumerator!)
                {
                    try
                    {
                        while (streamError is null)
                        {
                            ModelStreamEvent? streamEvent = null;
                            try
                            {
                                if (!await enumerator!.MoveNextAsync().ConfigureAwait(false)) break;
                                streamEvent = enumerator.Current;
                            }
                            catch (Exception exception)
                            {
                                streamError = exception;
                                break;
                            }

                            ChatRuntimeEvent? output = null;
                            try
                            {
                                runCancellation.ThrowIfCancellationRequested();
                                switch (streamEvent)
                                {
                                    case ModelStreamEvent.Started:
                                        if (started || completed) throw StreamFailure("A provider stream must emit Started exactly once.");
                                        started = true;
                                        break;
                                    case ModelStreamEvent.TextDelta delta:
                                        if (!started || completed) throw StreamFailure("A provider text delta was outside the active stream.");
                                        response.Append(delta.Text);
                                        requestTelemetry.FirstToken();
                                        output = new ChatRuntimeEvent.TextDelta(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model, delta.Text);
                                        break;
                                    case ModelStreamEvent.Usage reportedUsage:
                                        if (!started || completed || usageSeen) throw StreamFailure("A provider stream may emit Usage at most once before Completed.");
                                        usageSeen = true;
                                        usage = reportedUsage.Value;
                                        requestTelemetry.Usage(reportedUsage.Value);
                                        output = new ChatRuntimeEvent.UsageReported(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model, reportedUsage.Value);
                                        break;
                                    case ModelStreamEvent.Completed:
                                        if (!started || completed) throw StreamFailure("A provider stream must emit Completed exactly once after Started.");
                                        completed = true;
                                        break;
                                    default:
                                        throw StreamFailure("The provider stream contained an unsupported event.");
                                }
                            }
                            catch (Exception exception)
                            {
                                streamError = exception;
                            }
                            if (streamError is null && output is not null) yield return output;
                        }
                    }
                    finally
                    {
                        if (!completed || streamError is not null)
                        {
                            linkedCancellation.Cancel();
                        }
                    }
                }
            }

            ChatRuntimeEvent? completionOutput = null;
            if (streamError is null)
            {
                try
                {
                    runCancellation.ThrowIfCancellationRequested();
                    if (!started || !completed) throw StreamFailure("The provider stream ended before Started and Completed.");
                    if (response.Length == 0 || string.IsNullOrWhiteSpace(response.ToString())) throw StreamFailure("The provider returned an empty response.", AmiraErrorCodes.EmptyResponse);
                    TurnUsage? committedUsage = usage is null ? null : new TurnUsage(usage.InputTokens, usage.OutputTokens);
                    // Terminal commit is claim-authoritative. A caller disconnect racing this call must not turn a committed reply into Cancelled.
                    await _chatStore.CompleteTurnAsync(new CompleteTurnCommand(turn, response.ToString(), usage: committedUsage), claimed.ClaimToken, CancellationToken.None).ConfigureAwait(false);
                    terminalSettled = true;
                    requestTelemetry.Success();
                    turnTelemetry.Success();
                    completionOutput = new ChatRuntimeEvent.Completed(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model, response.ToString(), usage);
                }
                catch (Exception exception)
                {
                    streamError = exception;
                }
            }

            if (streamError is null && completionOutput is not null) yield return completionOutput;

            if (streamError is OperationCanceledException)
            {
                requestTelemetry.Cancelled();
                await CancelAfterProviderExitAsync(turn, claimed.ClaimToken).ConfigureAwait(false);
                terminalSettled = true;
                turnTelemetry.Cancelled();
                yield return new ChatRuntimeEvent.Cancelled(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model);
            }
            else if (streamError is AmiraException { Code: AmiraErrorCodes.TurnStopRequested })
            {
                requestTelemetry.Cancelled(AmiraErrorCodes.TurnStopRequested);
                await CancelAfterProviderExitAsync(turn, claimed.ClaimToken).ConfigureAwait(false);
                terminalSettled = true;
                turnTelemetry.Cancelled(AmiraErrorCodes.TurnStopRequested);
                yield return new ChatRuntimeEvent.Cancelled(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model);
            }
            else if (streamError is AmiraException productFailure)
            {
                AmiraError failure = productFailure.Error;
                requestTelemetry.Failure(failure.Code);
                ChatRuntimeEvent terminal = await SettleObservedFailureAsync(turn, claimed.ClaimToken, failure, turnTelemetry).ConfigureAwait(false);
                terminalSettled = true;
                yield return terminal;
            }
            else if (streamError is not null)
            {
                requestTelemetry.Failure(AmiraTelemetry.ErrorCodes.UnexpectedException);
                ExceptionDispatchInfo.Capture(streamError).Throw();
            }
        }
        finally
        {
            if (!terminalSettled)
            {
                linkedCancellation.Cancel();
                await CancelAfterProviderExitAsync(turn, claimed.ClaimToken).ConfigureAwait(false);
            }
            _activeTurns.TryRemove(new KeyValuePair<BotTurnId, CancellationTokenSource>(turn.Id, linkedCancellation));
        }
    }

    public async ValueTask<StopResult> StopAsync(BotTurnId turnId, CancellationToken cancellationToken = default)
    {
        await _chatStore.RequestStopAsync(turnId, cancellationToken).ConfigureAwait(false);
        bool signaled = _activeTurns.TryGetValue(turnId, out CancellationTokenSource? source);
        if (signaled) source!.Cancel();
        return new StopResult(true, signaled);
    }

    /// <summary>Explicit host startup recovery; call only after excluding workers from the previous process.</summary>
    public ValueTask RecoverInterruptedTurnsAsync(CancellationToken cancellationToken = default) =>
        _chatStore.RecoverInterruptedTurnsAsync(cancellationToken);

    public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) =>
        _chatStore.RetryTurnAsync(turnId, cancellationToken);

    private async ValueTask<ChatRuntimeEvent> SettleObservedFailureAsync(
        BotTurn turn,
        TurnClaimToken token,
        AmiraError failure,
        RuntimeTelemetryScope telemetry)
    {
        ChatRuntimeEvent terminal = await SettleFailureAsync(turn, token, failure).ConfigureAwait(false);
        switch (terminal)
        {
            case ChatRuntimeEvent.Cancelled:
                telemetry.Cancelled();
                break;
            case ChatRuntimeEvent.Failed failed:
                telemetry.Failure(failed.Failure.Code);
                break;
        }
        return terminal;
    }

    private async ValueTask<ChatRuntimeEvent> SettleFailureAsync(BotTurn turn, TurnClaimToken token, AmiraError failure)
    {
        try
        {
            await _chatStore.FailTurnAsync(turn.Id, token, failure, CancellationToken.None).ConfigureAwait(false);
            return FailureEvent(turn, failure);
        }
        catch (AmiraException exception) when (exception.Category == ErrorCategory.Concurrency && exception.Code == AmiraErrorCodes.TurnStopRequested)
        {
            await CancelAfterProviderExitAsync(turn, token).ConfigureAwait(false);
            return new ChatRuntimeEvent.Cancelled(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model);
        }
        catch (AmiraException exception) when (exception.Category == ErrorCategory.Concurrency && exception.Code == AmiraErrorCodes.StaleClaim)
        {
            return FailureEvent(turn, exception.Error);
        }
    }

    private async ValueTask CancelAfterProviderExitAsync(BotTurn turn, TurnClaimToken token)
    {
        await _chatStore.RequestStopAsync(turn.Id, CancellationToken.None).ConfigureAwait(false);
        try
        {
            await _chatStore.CancelClaimedTurnAsync(turn.Id, token, CancellationToken.None).ConfigureAwait(false);
        }
        catch (AmiraException exception) when (exception.Category == ErrorCategory.Concurrency && exception.Code == AmiraErrorCodes.StaleClaim)
        {
            // A terminal commit won before the stop request was linearized.
        }
    }

    private static ChatRuntimeEvent.Failed FailureEvent(BotTurn turn, AmiraError failure) =>
        new(turn.Id, turn.BotId, turn.ModelProfileSnapshot.Protocol, turn.ModelProfileSnapshot.Model, failure);

    private static AmiraError Error(string code, ErrorCategory category, string message, bool isTransient = false) =>
        new(code, category, message, isTransient);

    private static AmiraException StreamFailure(string message, string code = AmiraErrorCodes.InvalidStream) =>
        new(Error(code, ErrorCategory.Provider, message));
}
