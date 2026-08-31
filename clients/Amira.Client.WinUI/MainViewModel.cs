using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
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
    private string _statusText = string.Empty;
    private bool _isBusy;
    private bool _shuttingDown;
    private readonly HashSet<BotTurnId> _pendingTerminalTurns = [];
    private bool _terminalRefreshPending;
    private bool _terminalRefreshDirty;
    public ObservableCollection<Bot> Bots { get; } = [];
    public ObservableCollection<ChatMessage> Timeline { get; } = [];
    public ObservableCollection<ProviderConnection> Connections { get; } = [];
    public ObservableCollection<TurnView> Turns { get; } = [];
    public ObservableCollection<RuntimeTurnProjection> StreamingTurns { get; } = [];
    public event PropertyChangedEventHandler? PropertyChanged;
    public Bot? SelectedBot { get => _selectedBot; private set => Set(ref _selectedBot, value); }
    public string MessageText { get => _messageText; set { Set(ref _messageText, value); OnChanged(nameof(CanSend)); } }
    public string StatusText { get => _statusText; private set => Set(ref _statusText, value); }
    public bool IsBusy { get => _isBusy; private set => Set(ref _isBusy, value); }
    public bool CanSend => SelectedBot is not null && !IsBusy && !string.IsNullOrWhiteSpace(MessageText) && !_shuttingDown;
    public async Task InitializeAsync() { await RefreshCatalogAsync(); if (Bots.FirstOrDefault() is Bot bot) await SelectBotAsync(bot); }
    public async Task RefreshCatalogAsync()
    {
        BotId? selected = SelectedBot?.Id;
        IReadOnlyList<Bot> bots = await _session.ListBotsAsync();
        IReadOnlyList<ProviderConnection> connections = await _session.ListConnectionsAsync();
        Replace(Bots, bots.Where(bot => bot.LifecycleState == BotLifecycleState.Active));
        Replace(Connections, connections);
        if (selected is { } id) SelectedBot = Bots.FirstOrDefault(bot => bot.Id == id);
    }
    public async Task SelectBotAsync(Bot? bot)
    {
        _selectionCancellation?.Cancel();
        _selectionCancellation?.Dispose();
        CancellationTokenSource cancellation = new();
        _selectionCancellation = cancellation;
        long generation = _selection.Next();
        SelectedBot = bot;
        Timeline.Clear(); Turns.Clear(); StreamingTurns.Clear(); OnChanged(nameof(CanSend));
        if (bot is null || _shuttingDown) return;
        try
        {
            Task<IReadOnlyList<ChatMessage>> timeline = _session.LoadTimelineAsync(bot.DirectChatId, cancellation.Token).AsTask();
            Task<TurnPage> turns = _session.QueryTurnsAsync(new TurnQuery(botId: bot.Id), cancellation.Token).AsTask();
            await Task.WhenAll(timeline, turns);
            if (!IsCurrent(generation, bot.Id)) return;
            Replace(Timeline, await timeline); Replace(Turns, (await turns).Items);
        }
        catch (OperationCanceledException) when (!IsCurrent(generation, bot.Id)) { }
        catch (Exception exception) when (IsCurrent(generation, bot.Id)) { StatusText = ErrorPresentation.For(exception); }
    }
    public async Task SendAsync()
    {
        Bot? bot = SelectedBot; string content = MessageText;
        if (bot is null || string.IsNullOrWhiteSpace(content)) { StatusText = "Choose a Bot and enter a message."; return; }
        await RunAsync(async () => { await _session.SendAsync(bot.Id, content); MessageText = string.Empty; await SelectBotAsync(bot); });
    }
    public Task StopAsync(TurnView turn) => RunAsync(async () => { await _session.StopTurnAsync(turn.TurnId); await ReloadSelectedAsync(); });
    public Task RetryAsync(TurnView turn) => RunAsync(async () => { await _session.RetryAsync(turn.TurnId); await ReloadSelectedAsync(); });
    public async Task<bool> SaveConnectionAsync(ConnectionDraft draft, string? apiKey)
    {
        ArgumentNullException.ThrowIfNull(draft);
        if (_shuttingDown || IsBusy) return false;
        IsBusy = true; OnChanged(nameof(CanSend));
        try
        {
            if (!Uri.TryCreate(draft.BaseUrl, UriKind.Absolute, out Uri? baseUrl)) { StatusText = "Base URL must be an absolute URL."; return false; }
            if (draft.Editing is null)
            {
                if (string.IsNullOrWhiteSpace(apiKey)) { StatusText = "An API key is required for a new connection."; return false; }
                await _session.CreateProviderConnectionAsync(draft.Protocol, draft.DisplayName, baseUrl, apiKey, draft.DefaultModel, draft.Enabled);
            }
            else await _session.UpdateProviderConnectionAsync(draft.Editing, draft.DisplayName, baseUrl, string.IsNullOrWhiteSpace(apiKey) ? null : apiKey, draft.DefaultModel, draft.Enabled);
            await RefreshCatalogAsync(); StatusText = "Connection saved."; return true;
        }
        catch (Exception exception) { StatusText = ErrorPresentation.For(exception); return false; }
        finally { IsBusy = false; OnChanged(nameof(CanSend)); }
    }
    public async Task CreateBotAsync(BotDraft draft)
    {
        ArgumentNullException.ThrowIfNull(draft);
        await RunAsync(async () =>
        {
            if (draft.Connection is null) { StatusText = "Choose a provider connection."; return; }
            if (!double.TryParse(draft.Temperature, out double temperature) || temperature is < 0 or > 2) { StatusText = "Temperature must be a number between 0 and 2."; return; }
            if (!int.TryParse(draft.MaxTokens, out int maxTokens) || maxTokens <= 0) { StatusText = "Maximum tokens must be a positive whole number."; return; }
            BotProfile profile = BotProfile.Create(draft.Name, draft.Description, draft.Instructions);
            ModelProfile model = ModelProfile.Create(draft.Connection.Id, draft.Model, new GenerationOptions(temperature, maxTokens));
            Bot created = await _session.CreateBotAsync(new CreateBotCommand(profile, model));
            await RefreshCatalogAsync(); Bot? refreshed = Bots.FirstOrDefault(bot => bot.Id == created.Id); if (refreshed is not null) await SelectBotAsync(refreshed);
            StatusText = "Bot created.";
        });
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
    public void BeginShutdown() { _shuttingDown = true; _selectionCancellation?.Cancel(); OnChanged(nameof(CanSend)); }
    private async Task ReloadSelectedAsync() { Bot? bot = SelectedBot; if (bot is not null && !_shuttingDown) await SelectBotAsync(bot); }
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
        IsBusy = true; OnChanged(nameof(CanSend));
        try { await operation(); } catch (Exception exception) { StatusText = ErrorPresentation.For(exception); }
        finally { IsBusy = false; OnChanged(nameof(CanSend)); }
    }
    private static void Replace<T>(ObservableCollection<T> destination, IEnumerable<T> source) { destination.Clear(); foreach (T item in source) destination.Add(item); }
    private void Set<T>(ref T field, T value, [CallerMemberName] string? name = null) { if (EqualityComparer<T>.Default.Equals(field, value)) return; field = value; OnChanged(name); }
    private void OnChanged(string? name) => PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(name));
}

public sealed record ConnectionDraft(ProviderProtocol Protocol, string DisplayName, string BaseUrl, string? DefaultModel, bool Enabled, ProviderConnection? Editing = null);
public sealed record BotDraft(string Name, string Description, string Instructions, ProviderConnection? Connection, string Model, string Temperature, string MaxTokens);
