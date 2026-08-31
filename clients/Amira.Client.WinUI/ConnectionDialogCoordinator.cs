using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Amira.Domain;

namespace Amira.Client.WinUI;

internal sealed class ConnectionDialogCoordinator(MainViewModel viewModel, Func<XamlRoot?> xamlRoot)
{
    private MainViewModel ViewModel { get; } = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
    private XamlRoot XamlRoot => xamlRoot() ?? throw new InvalidOperationException("The connection dialog requires an active XamlRoot.");

    public async Task ShowManagementAsync()
    {
        ConnectionManagementFeedback? feedback = null;
        while (true)
        {
            ConnectionManagerResult? result = await ShowManagerOnceAsync(feedback);
            if (result is null) return;

            feedback = null;
            bool saved = result.Connection is null
                ? await ShowEditorAsync(ConnectionDraft.ForCreate(ConnectionDialogDisplayPolicy.Protocols[0].Protocol))
                : await ShowEditorAsync(ConnectionDraft.ForEdit(result.Connection));
            if (saved) feedback = ConnectionManagementFeedback.Success(ViewModel.StatusText);
        }
    }

    private async Task<ConnectionManagerResult?> ShowManagerOnceAsync(ConnectionManagementFeedback? feedback)
    {
        ProviderConnection[] connections = [.. ViewModel.Connections];
        InfoBar status = new()
        {
            Title = "Connection saved",
            Message = feedback?.Message ?? string.Empty,
            Severity = InfoBarSeverity.Success,
            IsOpen = feedback is not null,
            IsClosable = false
        };
        StackPanel content = new() { Spacing = 12, MinWidth = 420 };
        content.Children.Add(status);

        ListView? list = null;
        if (connections.Length == 0)
        {
            content.Children.Add(new TextBlock
            {
                Text = "No provider connections yet. Add one to create and run Bots.",
                TextWrapping = TextWrapping.Wrap,
                Opacity = .72
            });
        }
        else
        {
            list = new ListView
            {
                SelectionMode = ListViewSelectionMode.Single,
                MaxHeight = 280,
                IsTabStop = true
            };
            AutomationProperties.SetName(list, "Provider connections");
            ScrollViewer.SetVerticalScrollBarVisibility(list, ScrollBarVisibility.Auto);
            foreach (ProviderConnection connection in connections) list.Items.Add(CreateConnectionListItem(connection));
            content.Children.Add(list);
        }

        ContentDialog dialog = new()
        {
            XamlRoot = XamlRoot,
            Title = "Manage Connections",
            Content = content,
            PrimaryButtonText = "Add",
            SecondaryButtonText = "Edit",
            CloseButtonText = "Close",
            IsSecondaryButtonEnabled = false,
            MinWidth = 440,
            MaxWidth = 540
        };
        if (list is not null)
        {
            list.SelectionChanged += (_, _) => dialog.IsSecondaryButtonEnabled = list.SelectedItem is ListViewItem;
            list.SelectedIndex = 0;
        }

        ContentDialogResult response = await dialog.ShowAsync();
        ProviderConnection? selected = (list?.SelectedItem as ListViewItem)?.Tag as ProviderConnection;
        return ConnectionDialogDisplayPolicy.ResolveManagerAction(
            response == ContentDialogResult.Primary,
            response == ContentDialogResult.Secondary,
            selected is not null) switch
        {
            ConnectionManagerAction.Add => new ConnectionManagerResult(null),
            ConnectionManagerAction.Edit => new ConnectionManagerResult(selected!),
            _ => null
        };
    }

    private static ListViewItem CreateConnectionListItem(ProviderConnection connection)
    {
        string protocol = ConnectionDialogDisplayPolicy.ProtocolLabel(connection.Protocol);
        string status = ConnectionDialogDisplayPolicy.EnabledLabel(connection.Enabled);
        TextBlock name = new() { Text = connection.DisplayName, FontWeight = new Windows.UI.Text.FontWeight { Weight = 600 }, TextTrimming = TextTrimming.CharacterEllipsis };
        TextBlock protocolLabel = new() { Text = protocol, FontSize = 13, Opacity = .65 };
        StackPanel details = new() { Spacing = 2 };
        details.Children.Add(name);
        details.Children.Add(protocolLabel);
        Grid row = new();
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        row.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        row.Children.Add(details);
        TextBlock enabled = new() { Text = status, FontSize = 13, Opacity = .72, VerticalAlignment = VerticalAlignment.Center };
        Grid.SetColumn(enabled, 1);
        row.Children.Add(enabled);
        ListViewItem item = new() { Content = row, Tag = connection, Padding = new Thickness(12, 9, 12, 9) };
        AutomationProperties.SetName(item, $"{connection.DisplayName}, {protocol}, {status}");
        return item;
    }

    private async Task<bool> ShowEditorAsync(ConnectionDraft draft)
    {
        IReadOnlyList<ConnectionProtocolOption> protocols = ConnectionDialogDisplayPolicy.Protocols;
        ConnectionProtocolOption selectedProtocol = protocols.First(option => option.Protocol == draft.Protocol);
        ComboBox protocol = new()
        {
            ItemsSource = protocols,
            SelectedItem = selectedProtocol,
            DisplayMemberPath = nameof(ConnectionProtocolOption.DisplayName),
            IsEnabled = draft.Editing is null
        };
        AutomationProperties.SetName(protocol, draft.Editing is null ? "Protocol" : "Protocol, locked after creation");
        ToolTipService.SetToolTip(protocol, draft.Editing is null ? "Choose the provider protocol" : "Protocol cannot be changed after creation");
        TextBox displayName = WithAutomationName(new TextBox { Text = draft.DisplayName, PlaceholderText = "Connection name" }, "Display name");
        TextBox baseUrl = WithAutomationName(new TextBox { Text = draft.BaseUrl, PlaceholderText = "https://api.example.com/v1" }, "Base URL");
        PasswordBox apiKey = WithAutomationName(new PasswordBox { PlaceholderText = draft.Editing is null ? "Required" : "Leave blank to keep the current key" }, "API key");
        TextBox defaultModel = WithAutomationName(new TextBox { Text = draft.DefaultModel ?? string.Empty, PlaceholderText = "Optional" }, "Default model");
        ToggleSwitch enabled = new() { Header = "Enabled", OnContent = string.Empty, OffContent = string.Empty, IsOn = draft.Enabled };
        AutomationProperties.SetName(enabled, "Enabled");
        InfoBar feedback = new() { IsOpen = false, IsClosable = false, Severity = InfoBarSeverity.Error };
        StackPanel fields = new() { Spacing = 14 };
        fields.Children.Add(feedback);
        fields.Children.Add(CreateField("Protocol", protocol));
        fields.Children.Add(CreateField("Display name", displayName));
        fields.Children.Add(CreateField("Base URL", baseUrl));
        fields.Children.Add(CreateField("API key", apiKey));
        fields.Children.Add(CreateField("Default model", defaultModel));
        fields.Children.Add(enabled);
        ScrollViewer content = new() { Content = fields, MaxHeight = 560, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        ContentDialog dialog = new()
        {
            XamlRoot = XamlRoot,
            Title = draft.Editing is null ? "Add Connection" : "Edit Connection",
            Content = content,
            PrimaryButtonText = draft.Editing is null ? "Add" : "Save",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary
        };
        dialog.Opened += (_, _) => displayName.Focus(FocusState.Programmatic);
        bool saved = false;
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            ContentDialogButtonClickDeferral deferral = args.GetDeferral();
            string apiKeyValue = apiKey.Password;
            try
            {
                ConnectionProtocolOption selected = (ConnectionProtocolOption)protocol.SelectedItem;
                ConnectionDraft value = draft with
                {
                    Protocol = selected.Protocol,
                    DisplayName = displayName.Text,
                    BaseUrl = baseUrl.Text,
                    DefaultModel = defaultModel.Text,
                    Enabled = enabled.IsOn
                };
                if (await ViewModel.SaveConnectionAsync(value, apiKeyValue))
                {
                    saved = true;
                    return;
                }
                feedback.Title = "Could not save connection";
                feedback.Message = ViewModel.StatusText;
                feedback.Severity = InfoBarSeverity.Error;
                feedback.IsOpen = true;
                args.Cancel = true;
            }
            finally
            {
                apiKey.Password = string.Empty;
                deferral.Complete();
            }
        };
        await dialog.ShowAsync();
        return saved;
    }

    private static StackPanel CreateField(string label, UIElement input)
    {
        StackPanel field = new() { Spacing = 6 };
        field.Children.Add(new TextBlock { Text = label, FontWeight = new Windows.UI.Text.FontWeight { Weight = 600 } });
        field.Children.Add(input);
        return field;
    }

    private static T WithAutomationName<T>(T control, string name) where T : DependencyObject
    {
        AutomationProperties.SetName(control, name);
        return control;
    }

    private sealed record ConnectionManagerResult(ProviderConnection? Connection);
    private sealed record ConnectionManagementFeedback(string Message)
    {
        public static ConnectionManagementFeedback Success(string message) => new(message);
    }
}
