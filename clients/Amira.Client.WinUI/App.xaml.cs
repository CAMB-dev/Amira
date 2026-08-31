using Microsoft.UI.Xaml;
using Microsoft.UI.Dispatching;
using Amira.Client.Composition.Windows;

namespace Amira.Client.WinUI;

public partial class App : Application
{
    private Window? _window;
    private WindowsClientSession? _session;
    private WinUiChatRuntimeEventSink? _sink;
    private bool _launching;

    public App()
    {
        InitializeComponent();
    }

    protected override async void OnLaunched(LaunchActivatedEventArgs args)
    {
        if (_window is not null || _launching)
        {
            _window?.Activate();
            return;
        }

        _launching = true;
        WindowsClientSession? session = null;
        WinUiChatRuntimeEventSink? sink = null;
        try
        {
            sink = new WinUiChatRuntimeEventSink(DispatcherQueue.GetForCurrentThread());
            WindowsClientHost host = await WindowsClientHost.StartAsync(sink);
            session = new WindowsClientSession(host);
            MainViewModel viewModel = new(session);
            sink.Attach(viewModel.ProjectRuntimeEvent);
            await viewModel.InitializeAsync();

            MainWindow window = new(viewModel, session, sink);
            window.Activate();
            _session = session;
            _sink = sink;
            _window = window;
        }
        catch (Exception exception)
        {
            try { if (session is not null) await session.DisposeAsync(); }
            catch (Exception cleanup) { System.Diagnostics.Debug.WriteLine(cleanup); }
            try { if (sink is not null) await sink.CompleteAndDrainAsync(); }
            catch (Exception cleanup) { System.Diagnostics.Debug.WriteLine(cleanup); }
            _window = new Window
            {
                Title = "Amira",
                Content = new Microsoft.UI.Xaml.Controls.TextBlock
                {
                    Text = ErrorPresentation.For(exception),
                    Margin = new Thickness(24),
                    TextWrapping = TextWrapping.Wrap
                }
            };
            _window.Activate();
        }
        finally { _launching = false; }
    }
}
