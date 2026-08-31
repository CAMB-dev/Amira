using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;

namespace Amira.Client.WinUI;

public sealed partial class SettingsPage : UserControl
{
    private SettingsViewModel? _viewModel;
    private bool _syncingTheme;

    public SettingsPage()
    {
        InitializeComponent();
    }

    public event Action? CloseRequested;
    public event Action? ManageBotsRequested;
    public event Action? ManageConnectionsRequested;
    public event Action<AppThemePreference>? ThemePreferenceApplied;

    public void Configure(SettingsViewModel viewModel)
    {
        ArgumentNullException.ThrowIfNull(viewModel);
        if (_viewModel is not null) _viewModel.PropertyChanged -= ViewModelPropertyChanged;
        _viewModel = viewModel;
        DataContext = viewModel;
        _viewModel.PropertyChanged += ViewModelPropertyChanged;
        SyncThemeSelection();
    }

    public void FocusCloseButton() => CloseButton.Focus(FocusState.Programmatic);

    public void SyncThemeSelection()
    {
        if (_viewModel is null) return;
        _syncingTheme = true;
        ThemeSelector.SelectedIndex = ThemePreferencePolicy.SelectionIndex(_viewModel.ThemePreference);
        _syncingTheme = false;
    }

    private async void ThemeSelectionChanged(object sender, SelectionChangedEventArgs args)
    {
        if (_syncingTheme || _viewModel is null || ThemeSelector.SelectedIndex < 0) return;
        AppThemePreference requested = ThemePreferencePolicy.FromSelectionIndex(ThemeSelector.SelectedIndex);
        if (await _viewModel.ChangeThemeAsync(requested)) ThemePreferenceApplied?.Invoke(requested);
        SyncThemeSelection();
    }

    private async void OpenDataClick(object sender, RoutedEventArgs args)
    {
        if (_viewModel is not null) await _viewModel.OpenDataFolderAsync();
    }

    private async void OpenLogsClick(object sender, RoutedEventArgs args)
    {
        if (_viewModel is not null) await _viewModel.OpenLogsFolderAsync();
    }

    private void CopyWorkspaceClick(object sender, RoutedEventArgs args) => _viewModel?.CopyWorkspaceId();

    private void CopyDiagnosticsClick(object sender, RoutedEventArgs args) => _viewModel?.CopyDiagnostics();

    private void ManageConnectionsClick(object sender, RoutedEventArgs args) => ManageConnectionsRequested?.Invoke();

    private void ManageBotsClick(object sender, RoutedEventArgs args) => ManageBotsRequested?.Invoke();

    private void CloseClick(object sender, RoutedEventArgs args) => CloseRequested?.Invoke();

    private void CloseAcceleratorInvoked(KeyboardAccelerator sender, KeyboardAcceleratorInvokedEventArgs args)
    {
        args.Handled = true;
        CloseRequested?.Invoke();
    }

    private void NoticeClosed(InfoBar sender, InfoBarClosedEventArgs args) => _viewModel?.DismissNotice();

    private void ViewModelPropertyChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName == nameof(SettingsViewModel.ThemePreference)) SyncThemeSelection();
    }
}
