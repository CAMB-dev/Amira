using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Input;
using Windows.System;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml.Controls;

namespace Amira.Client.WinUI;

public sealed partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    private readonly IClientSession _session;
    private readonly WinUiChatRuntimeEventSink _sink;
    private bool _closeAllowed;
    private Task? _shutdown;
    public MainWindow(MainViewModel viewModel, IClientSession session, WinUiChatRuntimeEventSink sink)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        InitializeComponent();
        Root.DataContext = _viewModel;
        Title = "Amira";
        AppWindow.Closing += AppWindowClosing;
    }
    private async void BotsSelectionChanged(object sender, SelectionChangedEventArgs args) => await _viewModel.SelectBotAsync(BotsList.SelectedItem as Amira.Domain.Bot);
    private async void SendClick(object sender, RoutedEventArgs args) { _viewModel.MessageText = MessageBox.Text; await _viewModel.SendAsync(); }
    private async void MessageKeyDown(object sender, KeyRoutedEventArgs args) { if (args.Key == VirtualKey.Enter) { args.Handled = true; _viewModel.MessageText = MessageBox.Text; await _viewModel.SendAsync(); } }
    private void AppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_closeAllowed) return;
        args.Cancel = true;
        _viewModel.BeginShutdown();
        _shutdown ??= ShutdownAsync();
    }
    private async Task ShutdownAsync()
    {
        Exception? failure = null;
        try { await _session.DisposeAsync(); }
        catch (Exception exception) { failure = exception; }
        try { await _sink.CompleteAndDrainAsync(); }
        catch (Exception exception) { failure ??= exception; }
        if (failure is not null)
        {
            string message = ErrorPresentation.For(failure);
            System.Diagnostics.Debug.WriteLine(message);
            AppWindow.Title = message;
        }
        _closeAllowed = true;
        Close();
    }
}
