using System.Collections.Specialized;
using System.ComponentModel;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Windows.System;
using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Animation;
using Amira.Contracts;
using Amira.Domain;

namespace Amira.Client.WinUI;

public sealed partial class MainWindow : Window
{
    private readonly MainViewModel _viewModel;
    private readonly SettingsViewModel _settingsViewModel;
    private readonly IClientSession _session;
    private readonly WinUiChatRuntimeEventSink _sink;
    private readonly BotDialogCoordinator _botDialogs;
    private readonly ConnectionDialogCoordinator _connectionDialogs;
    private readonly IUiStringProvider _strings;
    private bool _closeAllowed;
    private Task? _shutdown;
    private bool _sidebarExpanded = true;
    private bool _conversationPinnedToBottom = true;
    private bool _scrollRequestPending;
    private bool _themeTransitionInProgress;
    private bool _settingsOpen;
    private bool _conversationHandlersAttached;
    private ScrollViewer? _conversationScrollViewer;
    public MainWindow(MainViewModel viewModel, SettingsViewModel settingsViewModel, IClientSession session, WinUiChatRuntimeEventSink sink)
    {
        _viewModel = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
        _settingsViewModel = settingsViewModel ?? throw new ArgumentNullException(nameof(settingsViewModel));
        _session = session ?? throw new ArgumentNullException(nameof(session));
        _sink = sink ?? throw new ArgumentNullException(nameof(sink));
        InitializeComponent();
        Root.DataContext = _viewModel;
        CollectionViewSource timelineDaysView = (CollectionViewSource)Root.Resources["TimelineDaysView"];
        timelineDaysView.Source = _viewModel.TimelineDays;
        ConversationList.ItemsSource = timelineDaysView.View;
        _strings = new MrtCoreUiStringProvider();
        _botDialogs = new BotDialogCoordinator(_viewModel, () => Root.XamlRoot);
        _connectionDialogs = new ConnectionDialogCoordinator(_viewModel, () => Root.XamlRoot);
        SettingsContent.Configure(_settingsViewModel);
        SettingsContent.CloseRequested += CloseSettings;
        SettingsContent.ManageBotsRequested += SettingsManageBotsRequested;
        SettingsContent.ManageConnectionsRequested += SettingsManageConnectionsRequested;
        SettingsContent.ThemePreferenceApplied += SettingsThemePreferenceApplied;
        _settingsViewModel.NoticePublished += SettingsNoticePublished;
        Title = "Amira";
        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);
        SystemBackdrop = new MicaBackdrop();
        Root.ActualThemeChanged += RootActualThemeChanged;
        ApplyThemePreference(_settingsViewModel.ThemePreference);
        AttachConversationHandlers();
        AppWindow.Resize(new Windows.Graphics.SizeInt32(1586, 992));
        AppWindow.Closing += AppWindowClosing;
    }
    private async void BotsSelectionChanged(object sender, SelectionChangedEventArgs args)
    {
        Bot? selected = BotsList.SelectedItem as Bot;
        if (!BotNavigationSelectionPolicy.ShouldOpen(selected, _viewModel.SelectedBot)) return;
        await _viewModel.SelectBotAsync(selected);
    }
    private async void SendClick(object sender, RoutedEventArgs args) { PinConversationToBottom(); _viewModel.MessageText = MessageBox.Text; await _viewModel.SendAsync(); }
    private async void MessagePreviewKeyDown(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key != VirtualKey.Enter || IsShiftDown()) return;
        args.Handled = true;
        PinConversationToBottom();
        _viewModel.MessageText = MessageBox.Text;
        await _viewModel.SendAsync();
    }
    private void PinConversationToBottom()
    {
        _conversationPinnedToBottom = true;
        ScheduleScrollToBottom();
    }
    private void MessageFocusChanged(object sender, RoutedEventArgs args) => AnimateComposerFocus(MessageBox.FocusState != FocusState.Unfocused);
    private void AnimateComposerFocus(bool focused)
    {
        double target = focused ? 1 : 0;
        if (!MotionPolicy.Current.AnimationsEnabled)
        {
            ComposerFocusRing.Opacity = target;
            return;
        }
        Storyboard storyboard = new();
        DoubleAnimation animation = new()
        {
            To = target,
            Duration = new Duration(TimeSpan.FromMilliseconds(90)),
            EnableDependentAnimation = true
        };
        Storyboard.SetTarget(animation, ComposerFocusRing);
        Storyboard.SetTargetProperty(animation, "Opacity");
        storyboard.Children.Add(animation);
        storyboard.Begin();
    }
    private void UserNoticeClosed(InfoBar sender, InfoBarClosedEventArgs args) => _viewModel.DismissNotice();
    private void SearchBotsTextChanged(AutoSuggestBox sender, AutoSuggestBoxTextChangedEventArgs args) => _viewModel.SearchText = sender.Text;
    private void ClearBotSearchClick(object sender, RoutedEventArgs args)
    {
        SearchBotsBox.Text = string.Empty;
        SearchBotsBox.Focus(FocusState.Programmatic);
    }
    private void RootPreviewKeyDown(object sender, KeyRoutedEventArgs args)
    {
        if (args.Key != VirtualKey.K || !IsControlDown()) return;
        args.Handled = true;
        SearchBotsBox.Focus(FocusState.Programmatic);
    }
    private static bool IsControlDown() => Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Control).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
    private async void ToggleThemeClick(object sender, RoutedEventArgs args)
    {
        AppThemePreference target = ThemePreferencePolicy.QuickToggle(Root.ActualTheme);
        if (await _settingsViewModel.ChangeThemeAsync(target)) await TransitionThemeAsync(target);
        else SettingsContent.SyncThemeSelection();
    }

    private async Task TransitionThemeAsync(AppThemePreference preference)
    {
        if (_themeTransitionInProgress)
        {
            ApplyThemePreference(preference);
            return;
        }

        _themeTransitionInProgress = true;
        try
        {
            MotionSettings motion = MotionPolicy.Current;
            if (!motion.AnimationsEnabled)
            {
                ApplyThemePreference(preference);
                return;
            }

            await FadeRootAsync(0, motion);
            ApplyThemePreference(preference);
            if (!await WaitForUiTurnAsync())
            {
                Root.Opacity = 1;
                return;
            }
            await FadeRootAsync(1, motion);
        }
        finally { _themeTransitionInProgress = false; }
    }

    private void ApplyThemePreference(AppThemePreference preference)
    {
        Root.RequestedTheme = ThemePreferencePolicy.RequestedTheme(preference);
        ApplyThemeChrome(Root.ActualTheme);
    }

    private void RootActualThemeChanged(FrameworkElement sender, object args) => ApplyThemeChrome(sender.ActualTheme);

    private void ApplyThemeChrome(ElementTheme actualTheme)
    {
        ThemeButtonText text = ThemeButtonTextPolicy.For(actualTheme, _strings);
        ThemeIcon.Glyph = text.Glyph;
        ToolTipService.SetToolTip(ThemeButton, text.ToolTip);
        AutomationProperties.SetName(ThemeButton, text.ToolTip);
        ApplyTitleBarTheme(actualTheme);
    }

    private void ApplyTitleBarTheme(ElementTheme theme)
    {
        bool dark = theme == ElementTheme.Dark;
        Windows.UI.Color foreground = dark
            ? Windows.UI.Color.FromArgb(255, 245, 245, 245)
            : Windows.UI.Color.FromArgb(255, 31, 31, 31);
        Windows.UI.Color inactiveForeground = dark
            ? Windows.UI.Color.FromArgb(255, 145, 145, 145)
            : Windows.UI.Color.FromArgb(255, 120, 120, 120);
        Windows.UI.Color hoverBackground = dark
            ? Windows.UI.Color.FromArgb(30, 255, 255, 255)
            : Windows.UI.Color.FromArgb(18, 0, 0, 0);
        Windows.UI.Color pressedBackground = dark
            ? Windows.UI.Color.FromArgb(56, 255, 255, 255)
            : Windows.UI.Color.FromArgb(38, 0, 0, 0);

        AppWindowTitleBar titleBar = AppWindow.TitleBar;
        titleBar.ButtonBackgroundColor = Windows.UI.Color.FromArgb(0, 0, 0, 0);
        titleBar.ButtonInactiveBackgroundColor = Windows.UI.Color.FromArgb(0, 0, 0, 0);
        titleBar.ButtonForegroundColor = foreground;
        titleBar.ButtonInactiveForegroundColor = inactiveForeground;
        titleBar.ButtonHoverBackgroundColor = hoverBackground;
        titleBar.ButtonHoverForegroundColor = foreground;
        titleBar.ButtonPressedBackgroundColor = pressedBackground;
        titleBar.ButtonPressedForegroundColor = foreground;
    }

    private Task FadeRootAsync(double targetOpacity, MotionSettings motion)
    {
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Storyboard storyboard = new();
        DoubleAnimation animation = new()
        {
            To = targetOpacity,
            Duration = new Duration(motion.ThemeFadeDuration),
            EnableDependentAnimation = true
        };
        Storyboard.SetTarget(animation, Root);
        Storyboard.SetTargetProperty(animation, "Opacity");
        storyboard.Children.Add(animation);
        storyboard.Completed += (_, _) => completion.SetResult();
        storyboard.Begin();
        return completion.Task;
    }

    private Task<bool> WaitForUiTurnAsync()
    {
        TaskCompletionSource<bool> completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        bool enqueued = DispatcherQueue.TryEnqueue(Microsoft.UI.Dispatching.DispatcherQueuePriority.Low, () =>
        {
            Root.UpdateLayout();
            completion.SetResult(true);
        });
        if (!enqueued) completion.SetResult(false);
        return completion.Task;
    }

    private void AttachConversationHandlers()
    {
        if (_conversationHandlersAttached) return;
        _viewModel.PropertyChanged += ViewModelPropertyChanged;
        _viewModel.Timeline.CollectionChanged += ConversationCollectionChanged;
        _viewModel.StreamingTurns.CollectionChanged += ConversationCollectionChanged;
        _conversationHandlersAttached = true;
    }

    private void DetachConversationHandlers()
    {
        if (!_conversationHandlersAttached) return;
        _viewModel.PropertyChanged -= ViewModelPropertyChanged;
        _viewModel.Timeline.CollectionChanged -= ConversationCollectionChanged;
        _viewModel.StreamingTurns.CollectionChanged -= ConversationCollectionChanged;
        _conversationHandlersAttached = false;
        DetachConversationScrollViewer();
    }

    private void ViewModelPropertyChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (args.PropertyName != nameof(MainViewModel.SelectedBot)) return;
        _conversationPinnedToBottom = true;
        ScheduleScrollToBottom();
    }

    private void ConversationCollectionChanged(object? sender, NotifyCollectionChangedEventArgs args)
    {
        if (_conversationPinnedToBottom) ScheduleScrollToBottom();
    }

    private void ConversationListLoaded(object sender, RoutedEventArgs args)
    {
        DetachConversationScrollViewer();
        _conversationScrollViewer = FindDescendant<ScrollViewer>(ConversationList);
        if (_conversationScrollViewer is null) return;
        _conversationScrollViewer.ViewChanged += ConversationScrollViewerViewChanged;
        _conversationScrollViewer.SizeChanged += ConversationScrollViewerSizeChanged;
        ScheduleScrollToBottom();
    }

    private void DetachConversationScrollViewer()
    {
        if (_conversationScrollViewer is null) return;
        _conversationScrollViewer.ViewChanged -= ConversationScrollViewerViewChanged;
        _conversationScrollViewer.SizeChanged -= ConversationScrollViewerSizeChanged;
        _conversationScrollViewer = null;
    }

    private void ConversationScrollViewerViewChanged(object? sender, ScrollViewerViewChangedEventArgs args)
    {
        if (_conversationScrollViewer is not ScrollViewer scrollViewer) return;
        _conversationPinnedToBottom = scrollViewer.ScrollableHeight - scrollViewer.VerticalOffset <= 48;
    }

    private void ConversationScrollViewerSizeChanged(object sender, SizeChangedEventArgs args)
    {
        if (_conversationPinnedToBottom) ScheduleScrollToBottom();
    }

    private void ScheduleScrollToBottom()
    {
        if (_scrollRequestPending || !_conversationPinnedToBottom) return;
        _scrollRequestPending = true;
        bool enqueued = DispatcherQueue.TryEnqueue(() =>
        {
            _scrollRequestPending = false;
            if (!_conversationPinnedToBottom) return;
            if (_conversationScrollViewer is not ScrollViewer scrollViewer) return;
            ConversationList.UpdateLayout();
            scrollViewer.ChangeView(null, scrollViewer.ScrollableHeight, null, true);
        });
        if (!enqueued) _scrollRequestPending = false;
    }

    private static T? FindDescendant<T>(DependencyObject root) where T : DependencyObject
    {
        int childCount = VisualTreeHelper.GetChildrenCount(root);
        for (int index = 0; index < childCount; index++)
        {
            DependencyObject child = VisualTreeHelper.GetChild(root, index);
            if (child is T descendant) return descendant;
            if (FindDescendant<T>(child) is T nested) return nested;
        }
        return null;
    }
    private const double SidebarExpandedWidth = 337;
    private const double SidebarCollapsedWidth = 68;
    private bool _sidebarAnimating;
    private async void ToggleSidebarClick(object sender, RoutedEventArgs args)
    {
        if (_sidebarAnimating) return;
        _sidebarExpanded = !_sidebarExpanded;
        if (!MotionPolicy.Current.AnimationsEnabled)
        {
            ApplySidebarState();
            return;
        }
        _sidebarAnimating = true;
        try
        {
            if (_sidebarExpanded)
            {
                SidebarColumn.Width = new GridLength(SidebarExpandedWidth);
                SetSidebarContentVisibility(true);
                await FadeElementsAsync(1, 110, BrandText, SidebarDetails, SidebarFooter);
            }
            else
            {
                await FadeElementsAsync(0, 70, BrandText, SidebarDetails, SidebarFooter);
                SetSidebarContentVisibility(false);
                SidebarColumn.Width = new GridLength(SidebarCollapsedWidth);
            }
        }
        finally { _sidebarAnimating = false; }
    }
    private void ApplySidebarState()
    {
        SidebarColumn.Width = new GridLength(_sidebarExpanded ? SidebarExpandedWidth : SidebarCollapsedWidth);
        Visibility value = _sidebarExpanded ? Visibility.Visible : Visibility.Collapsed;
        BrandText.Visibility = value;
        SidebarDetails.Visibility = value;
        SidebarFooter.Visibility = value;
        BrandText.Opacity = SidebarDetails.Opacity = SidebarFooter.Opacity = 1;
    }
    private void SetSidebarContentVisibility(bool visible)
    {
        if (visible) BrandText.Opacity = SidebarDetails.Opacity = SidebarFooter.Opacity = 0;
        Visibility value = visible ? Visibility.Visible : Visibility.Collapsed;
        BrandText.Visibility = value;
        SidebarDetails.Visibility = value;
        SidebarFooter.Visibility = value;
    }
    private static Task FadeElementsAsync(double target, int milliseconds, params FrameworkElement[] elements)
    {
        TaskCompletionSource completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
        Storyboard storyboard = new();
        foreach (FrameworkElement element in elements)
        {
            DoubleAnimation animation = new()
            {
                To = target,
                Duration = new Duration(TimeSpan.FromMilliseconds(milliseconds)),
                EnableDependentAnimation = true
            };
            Storyboard.SetTarget(animation, element);
            Storyboard.SetTargetProperty(animation, "Opacity");
            storyboard.Children.Add(animation);
        }
        storyboard.Completed += (_, _) => completion.SetResult();
        storyboard.Begin();
        return completion.Task;
    }
    private async void WorkspaceClick(object sender, RoutedEventArgs args)
    {
        ContentDialog dialog = new()
        {
            Title = "Local workspace",
            Content = $"Workspace ID\n{_viewModel.WorkspaceId}\n\nThis client is using the local Windows workspace.",
            PrimaryButtonText = "Open logs folder",
            CloseButtonText = "Close",
            DefaultButton = ContentDialogButton.Primary
        };
        ContentDialogChrome.Apply(dialog, Root.XamlRoot);
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await _viewModel.OpenLogsFolderAsync();
        }
    }
    private async void BotDetailsClick(object sender, RoutedEventArgs args)
    {
        Bot? bot = _viewModel.SelectedBot;
        if (bot is null) return;
        ContentDialog dialog = new()
        {
            Title = bot.Profile.Name,
            Content = $"{bot.Profile.Description}\n\nModel\n{bot.ModelProfile.Model}\n\n{bot.Profile.Instructions}",
            PrimaryButtonText = "Edit",
            CloseButtonText = "Close"
        };
        ContentDialogChrome.Apply(dialog, Root.XamlRoot);
        if (await dialog.ShowAsync() == ContentDialogResult.Primary)
        {
            await _botDialogs.ShowEditAsync(bot);
        }
    }

    private async void NewBotClick(object sender, RoutedEventArgs args) =>
        await _botDialogs.ShowCreateAsync();

    private async void ManageBotsClick(object sender, RoutedEventArgs args) => await _botDialogs.ShowManagementAsync();

    private async void ConnectionsClick(object sender, RoutedEventArgs args) => await _connectionDialogs.ShowManagementAsync();

    private void SettingsClick(object sender, RoutedEventArgs args) => OpenSettings();

    private async void OpenSettings()
    {
        if (_settingsOpen) return;
        _settingsOpen = true;
        SidebarPane.Visibility = Visibility.Collapsed;
        ConversationPane.Visibility = Visibility.Collapsed;
        ActivityPane.Visibility = Visibility.Collapsed;
        if (MotionPolicy.Current.AnimationsEnabled)
        {
            SettingsHost.Opacity = 0;
            SettingsHost.Visibility = Visibility.Visible;
            await FadeElementsAsync(1, 140, SettingsHost);
        }
        else
        {
            SettingsHost.Visibility = Visibility.Visible;
        }
        SettingsContent.FocusCloseButton();
    }

    private async void CloseSettings()
    {
        if (!_settingsOpen) return;
        _settingsOpen = false;
        if (MotionPolicy.Current.AnimationsEnabled) await FadeElementsAsync(0, 110, SettingsHost);
        SettingsHost.Visibility = Visibility.Collapsed;
        SettingsHost.Opacity = 1;
        SidebarPane.Visibility = Visibility.Visible;
        ConversationPane.Visibility = Visibility.Visible;
        ActivityPane.Visibility = Visibility.Visible;
        SettingsButton.Focus(FocusState.Programmatic);
    }

    private async void SettingsManageBotsRequested() => await _botDialogs.ShowManagementAsync();

    private async void SettingsManageConnectionsRequested() => await _connectionDialogs.ShowManagementAsync();

    private async void SettingsThemePreferenceApplied(AppThemePreference preference) => await TransitionThemeAsync(preference);

    private void SettingsNoticePublished(UserNotice notice)
    {
        if (!_settingsOpen) _viewModel.ShowNotice(notice);
    }

    private async void StopClick(object sender, RoutedEventArgs args)
    {
        if ((sender as FrameworkElement)?.Tag is TurnView turn) await _viewModel.StopAsync(turn);
    }
    private async void RetryClick(object sender, RoutedEventArgs args)
    {
        if ((sender as FrameworkElement)?.Tag is TurnView turn) await _viewModel.RetryAsync(turn);
    }
    private static bool IsShiftDown() => Microsoft.UI.Input.InputKeyboardSource.GetKeyStateForCurrentThread(VirtualKey.Shift).HasFlag(Windows.UI.Core.CoreVirtualKeyStates.Down);
    private void AppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_closeAllowed) return;
        args.Cancel = true;
        DetachConversationHandlers();
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
