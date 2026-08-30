using System.Windows;
using System.Windows.Controls;
using Amira.Contracts;
using Amira.Domain;

namespace Amira.Client.Wpf;

public partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    private readonly IClientSession _session;
    private readonly WpfChatRuntimeEventSink _sink;
    private Task? _shutdown;
    private bool _closeAllowed;
    private ProviderConnection? _editingConnection;
    public MainWindow(MainViewModel viewModel, IClientSession session, WpfChatRuntimeEventSink sink)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        DataContext = _viewModel;
        InitializeComponent();
        Closing += WindowClosing;
    }
    private async void BotsSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        Bot? selected = BotsList.SelectedItem as Bot;
        if (selected?.Id == _viewModel.SelectedBot?.Id) return;
        await _viewModel.SelectBotAsync(selected);
    }
    private async void SendClick(object sender, RoutedEventArgs e) => await _viewModel.SendAsync();
    private async void StopClick(object sender, RoutedEventArgs e) { if ((sender as FrameworkElement)?.Tag is TurnView turn && turn.Status is BotTurnStatus.Queued or BotTurnStatus.Running) await _viewModel.StopAsync(turn); }
    private async void RetryClick(object sender, RoutedEventArgs e) { if ((sender as FrameworkElement)?.Tag is TurnView turn && turn.Status is BotTurnStatus.Failed or BotTurnStatus.Cancelled) await _viewModel.RetryAsync(turn); }
    private async void SaveConnectionClick(object sender, RoutedEventArgs e)
    {
        string? key = ApiKey.Password;
        try
        {
            ProviderProtocol protocol = ProtocolBox.SelectedItem is ComboBoxItem { Tag: string tag } && Enum.TryParse(tag, out ProviderProtocol parsed) ? parsed : ProviderProtocol.OpenAIChatCompatible;
            bool saved = await _viewModel.SaveConnectionAsync(new(protocol, ConnectionName.Text, ConnectionUrl.Text, ConnectionModel.Text, ConnectionEnabled.IsChecked == true, _editingConnection), key);
            if (saved) ClearConnectionEditor();
        }
        finally { ApiKey.Clear(); }
    }
    private void ConnectionSelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        ApiKey.Clear();
        _editingConnection = ConnectionsList.SelectedItem as ProviderConnection;
        if (_editingConnection is null) { ProtocolBox.IsEnabled = true; return; }
        ConnectionName.Text = _editingConnection.DisplayName;
        ConnectionUrl.Text = _editingConnection.BaseUrl.AbsoluteUri;
        ConnectionModel.Text = _editingConnection.DefaultModel ?? string.Empty;
        ConnectionEnabled.IsChecked = _editingConnection.Enabled;
        ProtocolBox.SelectedIndex = (int)_editingConnection.Protocol;
        ProtocolBox.IsEnabled = false;
    }
    private void NewConnectionClick(object sender, RoutedEventArgs e)
    {
        ClearConnectionEditor();
    }
    private async void WindowClosing(object? sender, System.ComponentModel.CancelEventArgs e)
    {
        if (_closeAllowed) return;
        e.Cancel = true; IsEnabled = false; ApiKey.Clear(); _viewModel.BeginShutdown();
        try { _shutdown ??= ShutdownAsync(); await _shutdown; }
        catch (Exception exception) { MessageBox.Show(ErrorPresentation.For(exception), "Amira", MessageBoxButton.OK, MessageBoxImage.Error); }
        finally
        {
            if (!_closeAllowed) { _closeAllowed = true; Close(); }
        }
    }
    private void ClearConnectionEditor()
    {
        _editingConnection = null; ApiKey.Clear(); ConnectionName.Clear(); ConnectionUrl.Clear(); ConnectionModel.Clear(); ConnectionEnabled.IsChecked = true; ProtocolBox.SelectedIndex = 0; ProtocolBox.IsEnabled = true; ConnectionsList.SelectedItem = null;
    }
    private async Task ShutdownAsync()
    {
        Exception? failure = null;
        try { await _session.DisposeAsync(); } catch (Exception exception) { failure = exception; }
        try { await _sink.CompleteAndDrainAsync(); } catch (Exception exception) { failure ??= exception; }
        if (failure is not null) System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
    }
    private async void CreateBotClick(object sender, RoutedEventArgs e) => await _viewModel.CreateBotAsync(new(BotName.Text, BotDescription.Text, BotInstructions.Text, BotConnection.SelectedItem as ProviderConnection, BotModel.Text, BotTemperature.Text, BotMaxTokens.Text));
}
