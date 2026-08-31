using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;
using Amira.Client.Composition.Windows;

namespace Amira.Client.WinUI;

public partial class App : Application
{
    private Window? _window;
    private WindowsClientSession? _session;
    private WinUiChatRuntimeEventSink? _sink;

    public App()
    {
        InitializeComponent();
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        try
        {
            _sink = new WinUiChatRuntimeEventSink(DispatcherQueue.GetForCurrentThread());
            WindowsClientHost host = await WindowsClientHost.StartAsync(_sink);
            _session = new WindowsClientSession(host);
            MainViewModel viewModel = new(_session);
            _sink.Attach(viewModel.ProjectRuntimeEvent);
            _window = new MainWindow(viewModel, _session, _sink);
            _window.Activate();
            await viewModel.InitializeAsync();
        }
        catch (Exception exception)
        {
            try { if (_session is not null) await _session.DisposeAsync(); }
            catch (Exception cleanup) { System.Diagnostics.Debug.WriteLine(cleanup); }
            try { if (_sink is not null) await _sink.CompleteAndDrainAsync(); }
            catch (Exception cleanup) { System.Diagnostics.Debug.WriteLine(cleanup); }
            _window = new Window { Content = new Microsoft.UI.Xaml.Controls.TextBlock { Text = ErrorPresentation.For(exception), Margin = new Thickness(24), TextWrapping = TextWrapping.Wrap } };
            _window.Activate();
        }
    }
}
