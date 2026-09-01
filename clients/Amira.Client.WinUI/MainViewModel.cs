using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Client.WinUI;

public sealed class MainViewModel(IClientSession session, IFolderLauncher? folderLauncher = null) : INotifyPropertyChanged
{
    private readonly IClientSession _session = session ?? throw new ArgumentNullException(nameof(session));
    private readonly IFolderLauncher _folderLauncher = folderLauncher ?? new WindowsFolderLauncher();
    private readonly RuntimeEventProjection _projection = new();
    private readonly SelectionCoordinator _selection = new();
    private CancellationTokenSource? _selectionCancellation;
    private Bot? _selectedBot;
    private TurnView? _selectedActivity;
    private string _messageText = string.Empty;
    private string _searchText = string.Empty;
    private string _statusText = string.Empty;
    private UserNotice? _notice;
    private bool _isBusy;
    private bool _isCatalogLoading = true;
    private bool _isConversationLoading = true;
    private bool _shuttingDown;
    private bool _activitySelectionPinned;
    private readonly HashSet<BotTurnId> _firstTokenRefreshes = [];
    public ObservableCollection<Bot> AllBots { get; } = [];
    /// <summary>Active Bots shown in the chat navigation.</summary>
    public ObservableCollection<Bot> Bots { get; } = [];
    public ObservableCollection<Bot> VisibleBots { get; } = [];
    public ObservableCollection<ChatMessage> Timeline { get; } = [];
    /// <summary>Timeline bucketed into consecutive calendar-day groups for Direct chat display.</summary>
    public ObservableCollection<TimelineDayGroup> TimelineDays { get; } = [];
    public ObservableCollection<ProviderConnection> Connections { get; } = [];
    public ObservableCollection<TurnView> Turns { get; } = [];
    public ObservableCollection<RuntimeTurnProjection> StreamingTurns { get; } = [];
    public event PropertyChangedEventHandler? PropertyChanged;
    public Bot? SelectedBot
    {
        get => _selectedBot;
        private set
        {
            if (!Set(ref _selectedBot, value)) return;
            OnChanged(nameof(CanSend));
            OnChanged(nameof(CanEditSelectedBot));
            OnChanged(nameof(CanArchiveSelectedBot));
            OnChanged(nameof(ConversationState));
        }
    }
    public string MessageText { get => _messageText; set { Set(ref _messageText, value); OnChanged(nameof(CanSend)); } }
    public string SearchText
    {
        get => _searchText;
        set
        {
            if (string.Equals(_searchText, value, StringComparison.Ordinal)) return;
            _searchText = value;
            OnChanged(nameof(SearchText));
            RefreshVisibleBots();
        }
    }
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    public UserNotice? Notice
    {
        get => _notice;
        private set
        {
            _notice = value;
            OnChanged(nameof(Notice));
            OnChanged(nameof(HasNotice));
        }
    }
    public bool HasNotice => Notice is not null;
    public bool IsBusy
    {
        get => _isBusy;
        private set
        {
            if (!Set(ref _isBusy, value)) return;
            OnChanged(nameof(CanSend));
            OnChanged(nameof(CanCreateBot));
            OnChanged(nameof(CanEditSelectedBot));
            OnChanged(nameof(CanArchiveSelectedBot));
        }
    }
    public bool CanSend => BotManagementPolicy.CanSelect(SelectedBot) && !IsBusy && !string.IsNullOrWhiteSpace(MessageText) && !_shuttingDown;
    public bool CanCreateBot => !IsBusy && !_shuttingDown;
    public bool CanEditSelectedBot => BotManagementPolicy.CanEdit(SelectedBot) && !IsBusy && !_shuttingDown;
    public bool CanArchiveSelectedBot => BotManagementPolicy.CanArchive(SelectedBot) && !IsBusy && !_shuttingDown;
    public bool HasArchivedBots => AllBots.Any(bot => bot.LifecycleState == BotLifecycleState.Archived);
    public BotNavigationState NavigationState => ClientViewStatePolicy.ResolveNavigation(
        _isCatalogLoading,
        HasEnabledConnections,
        Bots.Count,
        AllBots.Count(bot => bot.LifecycleState == BotLifecycleState.Archived),
        !string.IsNullOrWhiteSpace(SearchText),
        VisibleBots.Count);
    public ConversationState ConversationState => ClientViewStatePolicy.ResolveConversation(
        _isConversationLoading,
        SelectedBot is not null,
        Timeline.Count,
        StreamingTurns.Count);
    public string WorkspaceId => _session.WorkspaceId.ToString();
    public TurnView? SelectedActivity
    {
        get => _selectedActivity;
        set
        {
            TurnView? selected = value is null
                ? null
                : Turns.FirstOrDefault(turn => turn.TurnId == value.TurnId);
            SetSelectedActivity(selected, selected is not null);
        }
    }
    public TurnView? CurrentActivity => SelectedActivity;
    public bool HasEnabledConnections => Connections.Any(connection => connection.Enabled);
    public string ConnectionSummary
    {
        get
        {
            int enabledConnections = Connections.Count(connection => connection.Enabled);
            return enabledConnections == 0 ? "None enabled" : $"{enabledConnections} enabled";
        }
    }
    public async Task InitializeAsync()
    {
        try
        {
            await RefreshCatalogAsync();
            if (Bots.FirstOrDefault() is Bot bot) await SelectBotAsync(bot);
        }
        finally
        {
            if (SelectedBot is null) SetConversationLoading(false);
        }
    }
    public async Task RefreshCatalogAsync()
    {
        SetCatalogLoading(true);
        try
        {
            BotId? selected = SelectedBot?.Id;
            IReadOnlyList<Bot> bots = await _session.ListBotsAsync();
            IReadOnlyList<ProviderConnection> connections = await _session.ListConnectionsAsync();
            Replace(AllBots, bots);
            Replace(Bots, bots.Where(BotManagementPolicy.CanSelect));
            Replace(Connections, connections);
            RefreshVisibleBots();
            OnChanged(nameof(HasEnabledConnections));
            OnChanged(nameof(ConnectionSummary));
            OnChanged(nameof(HasArchivedBots));
            if (selected is not { } id) return;
            Bot? refreshed = Bots.FirstOrDefault(bot => bot.Id == id);
            if (refreshed is null) ClearSelection();
            else SelectedBot = refreshed;
        }
        finally
        {
            SetCatalogLoading(false);
        }
    }
    public async Task SelectBotAsync(Bot? bot)
    {
        if (bot is not null && !BotManagementPolicy.CanSelect(bot))
        {
            PublishError(ProductError(
                AmiraErrorCodes.BotInactive,
                ErrorCategory.DomainRule,
                "The requested Bot is not active."));
            return;
        }
        bool sameBot = bot is not null && SelectedBot?.Id == bot.Id;
        BotTurnId? selectedActivityId = sameBot ? SelectedActivity?.TurnId : null;
        bool preservePinnedActivity = sameBot && _activitySelectionPinned;
        _selectionCancellation?.Cancel();
        _selectionCancellation?.Dispose();
        CancellationTokenSource cancellation = new();
        _selectionCancellation = cancellation;
        long generation = _selection.Next();
        SetConversationLoading(true);
        SelectedBot = bot;
        Timeline.Clear();
        TimelineDays.Clear();
        Turns.Clear();
        StreamingTurns.Clear();
        _firstTokenRefreshes.Clear();
        SetSelectedActivity(null, pinned: false);
        OnChanged(nameof(ConversationState));
        OnChanged(nameof(CanSend));
        if (bot is null || _shuttingDown)
        {
            SetConversationLoading(false);
            return;
        }
        try
        {
            Task<IReadOnlyList<ChatMessage>> timeline = _session.LoadTimelineAsync(bot.DirectChatId, cancellation.Token).AsTask();
            Task<TurnPage> turns = _session.QueryTurnsAsync(new TurnQuery(botId: bot.Id), cancellation.Token).AsTask();
            await Task.WhenAll(timeline, turns);
            if (!IsCurrent(generation, bot.Id)) return;
            IReadOnlyList<ChatMessage> messages = await timeline;
            Replace(Timeline, messages);
            RebuildTimelineDays();
            Replace(Turns, (await turns).Items);
            foreach (TurnView turn in Turns) RememberFirstToken(turn);
            RestoreActivitySelection(selectedActivityId, preservePinnedActivity);
            OnChanged(nameof(ConversationState));
        }
        catch (OperationCanceledException) when (!IsCurrent(generation, bot.Id)) { }
        catch (Exception exception) when (IsCurrent(generation, bot.Id)) { PublishError(exception); }
        finally
        {
            if (IsCurrent(generation, bot.Id)) SetConversationLoading(false);
        }
    }
    public async Task SendAsync()
    {
        Bot? bot = SelectedBot; string content = MessageText;
        if (bot is null || !BotManagementPolicy.CanSelect(bot))
        {
            PublishError(ProductError(
                AmiraErrorCodes.BotInactive,
                ErrorCategory.DomainRule,
                "Choose an active Bot."));
            return;
        }
        if (string.IsNullOrWhiteSpace(content))
        {
            PublishError(ProductError(
                AmiraErrorCodes.ContentRequired,
                ErrorCategory.Input,
                "Enter a message."));
            return;
        }
        if (IsBusy || _shuttingDown) return;
        ChatMessage optimisticEcho = CreateOptimisticEcho(bot, content);
        Timeline.Add(optimisticEcho);
        RebuildTimelineDays();
        OnChanged(nameof(ConversationState));
        MessageText = string.Empty;
        await RunAsync(async () =>
        {
            try
            {
                await _session.SendAsync(bot.Id, content);
            }
            catch
            {
                Timeline.Remove(optimisticEcho);
                RebuildTimelineDays();
                OnChanged(nameof(ConversationState));
                MessageText = content;
                throw;
            }
            await SelectBotAsync(bot);
        });
    }
    public Task StopAsync(TurnView turn) => RunAsync(async () => { await _session.StopTurnAsync(turn.TurnId); await ReloadSelectedAsync(); });
    public Task RetryAsync(TurnView turn) => RunAsync(async () => { await _session.RetryAsync(turn.TurnId); await ReloadSelectedAsync(); });
    public Task<bool> OpenLogsFolderAsync() => RunManagementAsync(
        () => LogsFolderLaunchPolicy.OpenAsync(_folderLauncher, _session.LogsDirectory),
        "Logs folder opened.");
    public Task<bool> SaveConnectionAsync(ConnectionDraft draft, string? apiKey)
    {
        ArgumentNullException.ThrowIfNull(draft);
        return RunManagementAsync(async () =>
        {
            ValidatedConnectionDraft values = ConnectionDraftPolicy.Validate(draft);
            ConnectionDraftPolicy.RequireCreateSecret(draft, apiKey);
            if (values.Editing is null)
            {
                await _session.CreateProviderConnectionAsync(
                    values.Protocol,
                    values.DisplayName,
                    values.BaseUrl,
                    apiKey!,
                    values.DefaultModel,
                    values.Enabled);
            }
            else
            {
                await _session.UpdateProviderConnectionAsync(
                    values.Editing,
                    values.DisplayName,
                    values.BaseUrl,
                    string.IsNullOrWhiteSpace(apiKey) ? null : apiKey,
                    values.DefaultModel,
                    values.Enabled);
            }
            await RefreshCatalogAsync();
        }, "Connection saved.");
    }
    public Task<bool> SaveBotAsync(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        return draft.Editing is null ? CreateBotAsync(draft) : EditBotAsync(draft);
    }

    public Task<bool> CreateBotAsync(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        return RunManagementAsync(async () =>
        {
            CreateBotCommand command = BotDraftPolicy.CreateCommand(draft);
            Bot created = await _session.CreateBotAsync(command);
            await RefreshCatalogAsync();
            Bot? refreshed = Bots.FirstOrDefault(bot => bot.Id == created.Id);
            if (refreshed is not null) await SelectBotAsync(refreshed);
        }, "Bot created.");
    }

    public Task<bool> EditBotAsync(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        return RunManagementAsync(async () =>
        {
            Bot edited = BotDraftPolicy.ApplyEdit(draft);
            bool wasSelected = SelectedBot?.Id == edited.Id;
            Bot saved = await _session.UpdateBotAsync(edited);
            await RefreshCatalogAsync();
            if (!wasSelected) return;
            Bot? refreshed = Bots.FirstOrDefault(bot => bot.Id == saved.Id);
            if (refreshed is null) ClearSelection();
            else await SelectBotAsync(refreshed);
        }, "Bot saved.");
    }

    public Task<bool> ArchiveBotAsync(Bot bot)
    {
        ArgumentNullException.ThrowIfNull(bot);
        return RunManagementAsync(async () =>
        {
            if (!BotManagementPolicy.CanArchive(bot))
                throw ProductError(AmiraErrorCodes.BotInactive, ErrorCategory.DomainRule, "Only an active Bot can be archived.");
            bool wasSelected = SelectedBot?.Id == bot.Id;
            _ = await _session.ArchiveBotAsync(bot.Id);
            await RefreshCatalogAsync();
            if (wasSelected) await SelectBotAsync(Bots.FirstOrDefault());
        }, "Bot archived.");
    }

    public Task<bool> RestoreBotAsync(Bot bot)
    {
        ArgumentNullException.ThrowIfNull(bot);
        return RunManagementAsync(async () =>
        {
            if (!BotManagementPolicy.CanRestore(bot))
                throw ProductError(AmiraErrorCodes.InvalidRequest, ErrorCategory.DomainRule, "Only an archived Bot can be restored.");
            BotId? selected = SelectedBot?.Id;
            Bot restored = await _session.RestoreBotAsync(bot.Id);
            await RefreshCatalogAsync();
            if (selected is null)
            {
                Bot? refreshed = Bots.FirstOrDefault(item => item.Id == restored.Id);
                if (refreshed is not null) await SelectBotAsync(refreshed);
            }
        }, "Bot restored.");
    }
    public async Task ProjectRuntimeEvent(ChatRuntimeEvent runtimeEvent)
    {
        ArgumentNullException.ThrowIfNull(runtimeEvent);
        if (_shuttingDown) return;
        RuntimeTurnProjection projection = _projection.Apply(runtimeEvent);
        if (SelectedBot?.Id != runtimeEvent.BotId)
        {
            if (projection.IsTerminal) _projection.Forget(projection.TurnId);
            return;
        }

        if (!projection.IsTerminal) UpsertStreamingTurn(projection);
        long generation = _selection.Capture();
        CancellationToken cancellationToken = _selectionCancellation?.Token ?? CancellationToken.None;
        try
        {
            switch (runtimeEvent)
            {
                case ChatRuntimeEvent.Started:
                    await RefreshTurnAsync(runtimeEvent, generation, cancellationToken);
                    break;
                case ChatRuntimeEvent.TextDelta when _firstTokenRefreshes.Add(runtimeEvent.TurnId):
                    await RefreshTurnAsync(runtimeEvent, generation, cancellationToken);
                    break;
                case ChatRuntimeEvent.UsageReported usage:
                    ProjectUsage(usage, generation);
                    break;
                case ChatRuntimeEvent.Completed or ChatRuntimeEvent.Failed or ChatRuntimeEvent.Cancelled:
                    await RefreshTerminalAsync(runtimeEvent, generation, cancellationToken);
                    break;
            }
        }
        catch (Exception exception)
        {
            if (IsCurrent(generation, runtimeEvent.BotId)) PublishError(exception);
        }
        finally
        {
            if (projection.IsTerminal)
            {
                RemoveStreamingTurn(runtimeEvent.TurnId);
                _projection.Forget(runtimeEvent.TurnId);
                _firstTokenRefreshes.Remove(runtimeEvent.TurnId);
            }
        }
    }
    public void BeginShutdown()
    {
        _shuttingDown = true;
        _selectionCancellation?.Cancel();
        OnChanged(nameof(CanSend));
        OnChanged(nameof(CanCreateBot));
        OnChanged(nameof(CanEditSelectedBot));
        OnChanged(nameof(CanArchiveSelectedBot));
    }
    public void DismissNotice() => Notice = null;
    public void ShowNotice(UserNotice notice)
    {
        ArgumentNullException.ThrowIfNull(notice);
        PublishNotice(notice);
    }
    private async Task ReloadSelectedAsync() { Bot? bot = SelectedBot; if (bot is not null && !_shuttingDown) await SelectBotAsync(bot); }
    private void ClearSelection()
    {
        SetConversationLoading(true);
        _selectionCancellation?.Cancel();
        _selectionCancellation?.Dispose();
        _selectionCancellation = null;
        _selection.Next();
        SelectedBot = null;
        Timeline.Clear();
        TimelineDays.Clear();
        Turns.Clear();
        StreamingTurns.Clear();
        _firstTokenRefreshes.Clear();
        SetSelectedActivity(null, pinned: false);
        OnChanged(nameof(ConversationState));
        SetConversationLoading(false);
    }
    private void RefreshVisibleBots()
    {
        string query = SearchText.Trim();
        Replace(VisibleBots, string.IsNullOrEmpty(query)
            ? Bots
            : Bots.Where(bot => bot.Profile.Name.Contains(query, StringComparison.OrdinalIgnoreCase)));
        OnChanged(nameof(NavigationState));
        OnChanged(nameof(SelectedBot));
    }
    private async Task RefreshTurnAsync(ChatRuntimeEvent runtimeEvent, long generation, CancellationToken cancellationToken)
    {
        TurnView? refreshed = await _session.GetTurnAsync(runtimeEvent.TurnId, cancellationToken);
        if (!IsCurrent(generation, runtimeEvent.BotId)) return;
        if (refreshed is null)
            throw ProductError(AmiraErrorCodes.TurnNotFound, ErrorCategory.NotFound, "The updated turn could not be found.");
        if (refreshed.BotId != runtimeEvent.BotId)
            throw ProductError(AmiraErrorCodes.BotLoadInconsistent, ErrorCategory.Persistence, "The updated turn belongs to another Bot.");
        UpsertTurn(refreshed);
    }
    private async Task RefreshTerminalAsync(ChatRuntimeEvent runtimeEvent, long generation, CancellationToken cancellationToken)
    {
        Exception? firstFailure = null;
        try { await RefreshTurnAsync(runtimeEvent, generation, cancellationToken); }
        catch (Exception exception) { firstFailure = exception; }
        try { await RefreshTimelineAsync(runtimeEvent, generation, cancellationToken); }
        catch (Exception exception) { firstFailure ??= exception; }
        if (firstFailure is not null) throw firstFailure;
    }
    private async Task RefreshTimelineAsync(ChatRuntimeEvent runtimeEvent, long generation, CancellationToken cancellationToken)
    {
        if (SelectedBot is not { } bot || bot.Id != runtimeEvent.BotId) return;
        IReadOnlyList<ChatMessage> timeline = await _session.LoadTimelineAsync(bot.DirectChatId, cancellationToken);
        if (IsCurrent(generation, runtimeEvent.BotId))
        {
            Replace(Timeline, timeline);
            RebuildTimelineDays();
            OnChanged(nameof(ConversationState));
        }
    }
    private void ProjectUsage(ChatRuntimeEvent.UsageReported runtimeEvent, long generation)
    {
        if (!IsCurrent(generation, runtimeEvent.BotId)) return;
        TurnView? current = Turns.FirstOrDefault(turn => turn.TurnId == runtimeEvent.TurnId);
        if (current is null) return;
        UpsertTurn(current with
        {
            Usage = new TurnUsage(runtimeEvent.Value.InputTokens, runtimeEvent.Value.OutputTokens),
        });
    }
    private void UpsertTurn(TurnView turn)
    {
        BotTurnId? selectedActivityId = SelectedActivity?.TurnId;
        bool preservePinnedActivity = _activitySelectionPinned;
        TurnView[] newestFirst =
        [
            .. Turns
                .Where(current => current.TurnId != turn.TurnId)
                .Append(turn)
                .OrderByDescending(current => current.QueuedAt)
                .ThenByDescending(current => current.TurnId.Value, StringComparer.Ordinal),
        ];
        Replace(Turns, newestFirst);
        RememberFirstToken(turn);
        RestoreActivitySelection(selectedActivityId, preservePinnedActivity);
    }
    private void RememberFirstToken(TurnView turn)
    {
        if (turn.FirstTokenAt is not null) _firstTokenRefreshes.Add(turn.TurnId);
    }
    private void RestoreActivitySelection(BotTurnId? selectedActivityId, bool preservePinnedActivity)
    {
        TurnView? preserved = selectedActivityId is { } turnId
            ? Turns.FirstOrDefault(turn => turn.TurnId == turnId)
            : null;
        if (preservePinnedActivity && preserved is not null)
        {
            SetSelectedActivity(preserved, pinned: true);
            return;
        }
        SetSelectedActivity(TurnActivityPolicy.SelectDefault(Turns), pinned: false);
    }
    private void SetSelectedActivity(TurnView? activity, bool pinned)
    {
        _activitySelectionPinned = pinned && activity is not null;
        if (ReferenceEquals(_selectedActivity, activity)) return;
        _selectedActivity = activity;
        OnChanged(nameof(SelectedActivity));
        OnChanged(nameof(CurrentActivity));
    }
    private void UpsertStreamingTurn(RuntimeTurnProjection projection)
    {
        for (int index = 0; index < StreamingTurns.Count; index++)
        {
            if (StreamingTurns[index].TurnId != projection.TurnId) continue;
            StreamingTurns[index] = projection;
            OnChanged(nameof(ConversationState));
            return;
        }
        StreamingTurns.Add(projection);
        OnChanged(nameof(ConversationState));
    }
    private void RemoveStreamingTurn(BotTurnId turnId)
    {
        bool removed = false;
        for (int index = StreamingTurns.Count - 1; index >= 0; index--)
        {
            if (StreamingTurns[index].TurnId != turnId) continue;
            StreamingTurns.RemoveAt(index);
            removed = true;
        }
        if (removed) OnChanged(nameof(ConversationState));
    }
    private bool IsCurrent(long generation, BotId botId) => !_shuttingDown && SelectedBot is { Id: var selected } && _selection.IsCurrent(generation, selected, botId);
    private async Task RunAsync(Func<Task> operation)
    {
        if (_shuttingDown || IsBusy) return;
        IsBusy = true;
        try
        {
            await operation();
        }
        catch (Exception exception)
        {
            PublishError(exception);
        }
        finally { IsBusy = false; }
    }
    private async Task<bool> RunManagementAsync(Func<Task> operation, string successMessage)
    {
        if (_shuttingDown || IsBusy) return false;
        IsBusy = true;
        try
        {
            await operation();
            PublishNotice(UserNotice.Successful(successMessage));
            return true;
        }
        catch (Exception exception)
        {
            PublishError(exception);
            return false;
        }
        finally { IsBusy = false; }
    }
    private void SetCatalogLoading(bool value)
    {
        if (_isCatalogLoading == value) return;
        _isCatalogLoading = value;
        OnChanged(nameof(NavigationState));
    }
    private void SetConversationLoading(bool value)
    {
        if (_isConversationLoading == value) return;
        _isConversationLoading = value;
        OnChanged(nameof(ConversationState));
    }
    private static void Replace<T>(ObservableCollection<T> destination, IEnumerable<T> source) { destination.Clear(); foreach (T item in source) destination.Add(item); }
    private void RebuildTimelineDays() => Replace(TimelineDays, TimelineGroupingPolicy.GroupByDay(Timeline));
    private static ChatMessage CreateOptimisticEcho(Bot bot, string content)
    {
        MessageId messageId = MessageId.New();
        MessageRevision revision = MessageRevision.Create(messageId, content);
        return new ChatMessage(messageId, bot.DirectChatId, MessageAuthor.Human, revision, DateTimeOffset.UtcNow, MessageStatus.Committed);
    }
    private bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null) { if (EqualityComparer<T>.Default.Equals(field, value)) return false; field = value; OnChanged(name); return true; }
    private void PublishError(Exception exception) => PublishNotice(UserNotice.FromError(exception));
    private void PublishNotice(UserNotice notice)
    {
        StatusText = notice.Message;
        Notice = notice;
    }
    private static AmiraException ProductError(string code, ErrorCategory category, string message) =>
        new(new AmiraError(code, category, message));
    private void OnChanged(string? name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
