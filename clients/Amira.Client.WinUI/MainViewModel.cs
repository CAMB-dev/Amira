using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Client.WinUI;

public sealed class MainViewModel(IClientSession session) : INotifyPropertyChanged
{
    private readonly IClientSession _session = session ?? throw new ArgumentNullException(nameof(session));
    private readonly RuntimeEventProjection _projection = new();
    private readonly SelectionCoordinator _selection = new();
    private CancellationTokenSource? _selectionCancellation;
    private Bot? _selectedBot;
    private string _messageText = string.Empty;
    private string _searchText = string.Empty;
    private string _statusText = string.Empty;
    private bool _isBusy;
    private bool _shuttingDown;
    private readonly HashSet<BotTurnId> _pendingTerminalTurns = [];
    private bool _terminalRefreshPending;
    private bool _terminalRefreshDirty;
    public ObservableCollection<Bot> AllBots { get; } = [];
    /// <summary>Active Bots shown in the chat navigation.</summary>
    public ObservableCollection<Bot> Bots { get; } = [];
    public ObservableCollection<Bot> VisibleBots { get; } = [];
    public ObservableCollection<ChatMessage> Timeline { get; } = [];
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
    public string WorkspaceId => _session.WorkspaceId.ToString();
    public TurnView? CurrentActivity => Turns.FirstOrDefault();
    public bool HasEnabledConnections => Connections.Any(connection => connection.Enabled);
    public string ConnectionSummary
    {
        get
        {
            int enabledConnections = Connections.Count(connection => connection.Enabled);
            return enabledConnections == 0 ? "None enabled" : $"{enabledConnections} enabled";
        }
    }
    public async Task InitializeAsync() { await RefreshCatalogAsync(); if (Bots.FirstOrDefault() is Bot bot) await SelectBotAsync(bot); }
    public async Task RefreshCatalogAsync()
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
    public async Task SelectBotAsync(Bot? bot)
    {
        if (bot is not null && !BotManagementPolicy.CanSelect(bot))
        {
            StatusText = ErrorPresentation.For(ProductError(
                AmiraErrorCodes.BotInactive,
                ErrorCategory.DomainRule,
                "The requested Bot is not active."));
            return;
        }
        _selectionCancellation?.Cancel();
        _selectionCancellation?.Dispose();
        CancellationTokenSource cancellation = new();
        _selectionCancellation = cancellation;
        long generation = _selection.Next();
        SelectedBot = bot;
        Timeline.Clear(); Turns.Clear(); StreamingTurns.Clear(); OnChanged(nameof(CurrentActivity)); OnChanged(nameof(CanSend));
        if (bot is null || _shuttingDown) return;
        try
        {
            Task<IReadOnlyList<ChatMessage>> timeline = _session.LoadTimelineAsync(bot.DirectChatId, cancellation.Token).AsTask();
            Task<TurnPage> turns = _session.QueryTurnsAsync(new TurnQuery(botId: bot.Id), cancellation.Token).AsTask();
            await Task.WhenAll(timeline, turns);
            if (!IsCurrent(generation, bot.Id)) return;
            Replace(Timeline, await timeline); Replace(Turns, (await turns).Items); OnChanged(nameof(CurrentActivity));
        }
        catch (OperationCanceledException) when (!IsCurrent(generation, bot.Id)) { }
        catch (Exception exception) when (IsCurrent(generation, bot.Id)) { StatusText = ErrorPresentation.For(exception); }
    }
    public async Task SendAsync()
    {
        Bot? bot = SelectedBot; string content = MessageText;
        if (bot is null || !BotManagementPolicy.CanSelect(bot))
        {
            StatusText = ErrorPresentation.For(ProductError(
                AmiraErrorCodes.BotInactive,
                ErrorCategory.DomainRule,
                "Choose an active Bot."));
            return;
        }
        if (string.IsNullOrWhiteSpace(content))
        {
            StatusText = ErrorPresentation.For(ProductError(
                AmiraErrorCodes.ContentRequired,
                ErrorCategory.Input,
                "Enter a message."));
            return;
        }
        await RunAsync(async () => { await _session.SendAsync(bot.Id, content); MessageText = string.Empty; await SelectBotAsync(bot); });
    }
    public Task StopAsync(TurnView turn) => RunAsync(async () => { await _session.StopTurnAsync(turn.TurnId); await ReloadSelectedAsync(); });
    public Task RetryAsync(TurnView turn) => RunAsync(async () => { await _session.RetryAsync(turn.TurnId); await ReloadSelectedAsync(); });
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
    public Task ProjectRuntimeEvent(ChatRuntimeEvent runtimeEvent)
    {
        if (_shuttingDown) return Task.CompletedTask;
        RuntimeTurnProjection projection = _projection.Apply(runtimeEvent);
        if (SelectedBot?.Id != runtimeEvent.BotId) { if (projection.IsTerminal) _projection.Forget(projection.TurnId); return Task.CompletedTask; }
        int index = StreamingTurns.ToList().FindIndex(item => item.TurnId == projection.TurnId);
        if (projection.IsTerminal) { _pendingTerminalTurns.Add(projection.TurnId); ScheduleTerminalRefresh(); }
        else if (index >= 0) StreamingTurns[index] = projection; else StreamingTurns.Add(projection);
        return Task.CompletedTask;
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
    private async Task ReloadSelectedAsync() { Bot? bot = SelectedBot; if (bot is not null && !_shuttingDown) await SelectBotAsync(bot); }
    private void ClearSelection()
    {
        _selectionCancellation?.Cancel();
        _selectionCancellation?.Dispose();
        _selectionCancellation = null;
        _selection.Next();
        SelectedBot = null;
        Timeline.Clear();
        Turns.Clear();
        StreamingTurns.Clear();
        OnChanged(nameof(CurrentActivity));
    }
    private void RefreshVisibleBots()
    {
        string query = SearchText.Trim();
        Replace(VisibleBots, string.IsNullOrEmpty(query)
            ? Bots
            : Bots.Where(bot => bot.Profile.Name.Contains(query, StringComparison.OrdinalIgnoreCase)));
    }
    private void ScheduleTerminalRefresh() { _terminalRefreshDirty = true; if (_terminalRefreshPending) return; _terminalRefreshPending = true; _ = RefreshAfterTerminalAsync(); }
    private async Task RefreshAfterTerminalAsync()
    {
        try { while (_terminalRefreshDirty && !_shuttingDown) { _terminalRefreshDirty = false; await ReloadSelectedAsync(); } foreach (BotTurnId id in _pendingTerminalTurns) _projection.Forget(id); _pendingTerminalTurns.Clear(); }
        finally { _terminalRefreshPending = false; if (_terminalRefreshDirty && !_shuttingDown) ScheduleTerminalRefresh(); }
    }
    private bool IsCurrent(long generation, BotId botId) => !_shuttingDown && SelectedBot is { Id: var selected } && _selection.IsCurrent(generation, selected, botId);
    private async Task RunAsync(Func<Task> operation)
    {
        if (_shuttingDown || IsBusy) return;
        IsBusy = true;
        try { await operation(); } catch (Exception exception) { StatusText = ErrorPresentation.For(exception); }
        finally { IsBusy = false; }
    }
    private async Task<bool> RunManagementAsync(Func<Task> operation, string successMessage)
    {
        if (_shuttingDown || IsBusy) return false;
        IsBusy = true;
        try
        {
            await operation();
            StatusText = successMessage;
            return true;
        }
        catch (Exception exception)
        {
            StatusText = ErrorPresentation.For(exception);
            return false;
        }
        finally { IsBusy = false; }
    }
    private static void Replace<T>(ObservableCollection<T> destination, IEnumerable<T> source) { destination.Clear(); foreach (T item in source) destination.Add(item); }
    private bool Set<T>(ref T field, T value, [CallerMemberName] string? name = null) { if (EqualityComparer<T>.Default.Equals(field, value)) return false; field = value; OnChanged(name); return true; }
    private static AmiraException ProductError(string code, ErrorCategory category, string message) =>
        new(new AmiraError(code, category, message));
    private void OnChanged(string? name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}
