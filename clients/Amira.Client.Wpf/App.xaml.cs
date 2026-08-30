using System.Windows;
using Amira.Client.Composition.Windows;

namespace Amira.Client.Wpf;

public partial class App : Application
{
    private WindowsClientSession? _session;
    private WpfChatRuntimeEventSink? _sink;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        _sink = new WpfChatRuntimeEventSink(Dispatcher);
        try
        {
            WindowsClientHost host = await WindowsClientHost.StartAsync(_sink);
            _session = new WindowsClientSession(host);
            var viewModel = new MainViewModel(_session);
            _sink.Attach(viewModel.ProjectRuntimeEvent);
            var window = new MainWindow(viewModel, _session, _sink);
            MainWindow = window;
            window.Show();
            await viewModel.InitializeAsync();
        }
        catch (Exception exception)
        {
            try { if (_session is not null) await _session.DisposeAsync(); }
            catch { }
            try { if (_sink is not null) await _sink.CompleteAndDrainAsync(); }
            catch { }
            MessageBox.Show(ErrorPresentation.For(exception), "Amira", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(-1);
        }
    }

}
