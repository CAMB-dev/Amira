using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Automation;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Amira.Domain;

namespace Amira.Client.WinUI;

internal sealed class BotDialogCoordinator(MainViewModel viewModel, Func<XamlRoot?> xamlRoot)
{
    private MainViewModel ViewModel { get; } = viewModel ?? throw new ArgumentNullException(nameof(viewModel));
    private XamlRoot XamlRoot => xamlRoot() ?? throw new InvalidOperationException("The Bot dialog requires an active XamlRoot.");

    public Task<bool> ShowCreateAsync() =>
        ShowEditorAsync(BotDraft.ForCreate(ViewModel.Connections.Where(connection => connection.Enabled)));

    public Task<bool> ShowEditAsync(Bot bot)
    {
        ArgumentNullException.ThrowIfNull(bot);
        return ShowEditorAsync(BotDraft.ForEdit(bot, ViewModel.Connections));
    }

    public async Task ShowManagementAsync()
    {
        ManagementFeedback? feedback = null;
        while (true)
        {
            ManagedBotDialogResult? result = await ShowManagerOnceAsync(feedback);
            if (result is null) return;

            feedback = null;
            switch (result.Action)
            {
                case BotManagerAction.Edit:
                    if (await ShowEditAsync(result.Bot)) feedback = ManagementFeedback.Success(ViewModel.StatusText);
                    break;
                case BotManagerAction.Archive:
                    if (await ConfirmArchiveAsync(result.Bot))
                    {
                        bool archived = await ViewModel.ArchiveBotAsync(result.Bot);
                        feedback = ManagementFeedback.FromOperation(ViewModel.StatusText, archived);
                    }
                    break;
                case BotManagerAction.Restore:
                    bool restored = await ViewModel.RestoreBotAsync(result.Bot);
                    feedback = ManagementFeedback.FromOperation(ViewModel.StatusText, restored);
                    break;
                default:
                    throw new ArgumentOutOfRangeException(nameof(result.Action), result.Action, "Unsupported Bot manager action.");
            }
        }
    }

    private async Task<ManagedBotDialogResult?> ShowManagerOnceAsync(ManagementFeedback? feedback)
    {
        Bot[] bots = [.. ViewModel.AllBots];
        InfoBar status = new()
        {
            Title = feedback?.Succeeded == true ? "Bot updated" : "Could not update Bot",
            Message = feedback?.Message ?? string.Empty,
            Severity = feedback?.Succeeded == true ? InfoBarSeverity.Success : InfoBarSeverity.Error,
            IsOpen = feedback is not null,
            IsClosable = false
        };
        StackPanel content = new() { Spacing = 12, MinWidth = 420 };
        content.Children.Add(status);

        ListView? list = null;
        if (bots.Length == 0)
        {
            content.Children.Add(new TextBlock
            {
                Text = "No Bots yet. Create one to begin a direct chat.",
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
            AutomationProperties.SetName(list, "Bots");
            ScrollViewer.SetVerticalScrollBarVisibility(list, ScrollBarVisibility.Auto);
            foreach (Bot bot in bots) list.Items.Add(CreateBotListItem(bot));
            content.Children.Add(list);
        }

        ContentDialog dialog = new()
        {
            Title = "Manage Bots",
            Content = content,
            PrimaryButtonText = "Edit",
            SecondaryButtonText = "Archive",
            CloseButtonText = "Close",
            IsPrimaryButtonEnabled = false,
            IsSecondaryButtonEnabled = false,
            DefaultButton = ContentDialogButton.Primary
        };
        ContentDialogChrome.Apply(dialog, XamlRoot);
        if (list is not null)
        {
            list.SelectionChanged += (_, _) => ConfigureManagerActions(dialog, list.SelectedItem as ListViewItem);
            list.SelectedIndex = 0;
        }

        ContentDialogResult response = await dialog.ShowAsync();
        Bot? selectedBot = (list?.SelectedItem as ListViewItem)?.Tag as Bot;
        if (selectedBot is null) return null;
        return response switch
        {
            ContentDialogResult.Primary => new ManagedBotDialogResult(selectedBot, BotManagerAction.Edit),
            ContentDialogResult.Secondary when BotManagementDialogPolicy.SecondaryAction(selectedBot.LifecycleState) is { } action => new ManagedBotDialogResult(selectedBot, action),
            _ => null
        };
    }

    private static ListViewItem CreateBotListItem(Bot bot)
    {
        TextBlock name = new() { Text = bot.Profile.Name, FontWeight = new Windows.UI.Text.FontWeight { Weight = 600 }, TextTrimming = TextTrimming.CharacterEllipsis };
        TextBlock lifecycle = new() { Text = BotManagementDialogPolicy.LifecycleLabel(bot.LifecycleState), FontSize = 13, Opacity = .65 };
        StackPanel text = new() { Spacing = 2 };
        text.Children.Add(name);
        text.Children.Add(lifecycle);
        ListViewItem item = new() { Content = text, Tag = bot, Padding = new Thickness(12, 9, 12, 9) };
        AutomationProperties.SetName(item, $"{bot.Profile.Name}, {lifecycle.Text}");
        return item;
    }

    private static void ConfigureManagerActions(ContentDialog dialog, ListViewItem? item)
    {
        Bot? selected = item?.Tag as Bot;
        BotManagerAction? action = selected is null ? null : BotManagementDialogPolicy.SecondaryAction(selected.LifecycleState);
        dialog.IsPrimaryButtonEnabled = selected is not null;
        dialog.IsSecondaryButtonEnabled = action is not null;
        if (action is { } secondary) dialog.SecondaryButtonText = BotManagementDialogPolicy.ActionLabel(secondary);
    }

    private async Task<bool> ConfirmArchiveAsync(Bot bot)
    {
        ContentDialog dialog = new()
        {
            Title = "Archive Bot?",
            Content = $"Archive {bot.Profile.Name}? It will be removed from chat navigation until restored.",
            PrimaryButtonText = "Archive",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Close
        };
        ContentDialogChrome.Apply(dialog, XamlRoot);
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private async Task<bool> ShowEditorAsync(BotDraft draft)
    {
        IReadOnlyList<ProviderConnection> connections = draft.Editing is null
            ? [.. ViewModel.Connections.Where(connection => connection.Enabled)]
            : [.. ViewModel.Connections];
        TextBox name = WithAutomationName(new TextBox { Text = draft.Name, PlaceholderText = "Bot name" }, "Bot name");
        TextBox description = WithAutomationName(new TextBox { Text = draft.Description, PlaceholderText = "What this Bot does", TextWrapping = TextWrapping.Wrap }, "Description");
        TextBox instructions = WithAutomationName(new TextBox { Text = draft.Instructions, PlaceholderText = "Instructions", AcceptsReturn = true, TextWrapping = TextWrapping.Wrap, MinHeight = 96 }, "Instructions");
        ComboBox connection = new()
        {
            ItemsSource = connections,
            SelectedItem = connections.FirstOrDefault(item => item.Id == draft.Connection?.Id),
            DisplayMemberPath = nameof(ProviderConnection.DisplayName),
            IsEnabled = connections.Count > 0,
            MaxDropDownHeight = 240
        };
        AutomationProperties.SetName(connection, "Provider connection");
        TextBox model = WithAutomationName(new TextBox { Text = draft.Model, PlaceholderText = "Model" }, "Model");
        TextBox temperature = WithAutomationName(new TextBox { Text = draft.Temperature, PlaceholderText = "Optional, for example 0.7", InputScope = new InputScope { Names = { new InputScopeName(InputScopeNameValue.Number) } } }, "Temperature");
        TextBox maxTokens = WithAutomationName(new TextBox { Text = draft.MaxTokens, PlaceholderText = "Optional", InputScope = new InputScope { Names = { new InputScopeName(InputScopeNameValue.Number) } } }, "Max output tokens");
        InfoBar feedback = new()
        {
            Title = connections.Count == 0 ? "No enabled provider connections" : string.Empty,
            Message = connections.Count == 0 ? "Add and enable a provider connection before creating a Bot." : string.Empty,
            Severity = InfoBarSeverity.Error,
            IsOpen = connections.Count == 0,
            IsClosable = false
        };
        StackPanel fields = new() { Spacing = 14 };
        fields.Children.Add(feedback);
        fields.Children.Add(CreateField("Name", name));
        fields.Children.Add(CreateField("Description", description));
        fields.Children.Add(CreateField("Instructions", instructions));
        fields.Children.Add(CreateField("Provider connection", connection));
        fields.Children.Add(CreateField("Model", model));
        fields.Children.Add(CreateField("Temperature", temperature));
        fields.Children.Add(CreateField("Max output tokens", maxTokens));
        ScrollViewer content = new() { Content = fields, MaxHeight = 560, VerticalScrollBarVisibility = ScrollBarVisibility.Auto };
        ContentDialog dialog = new()
        {
            Title = draft.Editing is null ? "Create Bot" : "Edit Bot",
            Content = content,
            PrimaryButtonText = draft.Editing is null ? "Create" : "Save",
            CloseButtonText = "Cancel",
            IsPrimaryButtonEnabled = connections.Count > 0,
            DefaultButton = ContentDialogButton.Primary
        };
        ContentDialogChrome.Apply(dialog, XamlRoot);
        dialog.Opened += (_, _) => name.Focus(FocusState.Programmatic);
        bool saved = false;
        dialog.PrimaryButtonClick += async (_, args) =>
        {
            ContentDialogButtonClickDeferral deferral = args.GetDeferral();
            try
            {
                BotDraft value = draft with
                {
                    Name = name.Text,
                    Description = description.Text,
                    Instructions = instructions.Text,
                    Connection = connection.SelectedItem as ProviderConnection,
                    Model = model.Text,
                    Temperature = temperature.Text,
                    MaxTokens = maxTokens.Text
                };
                if (await ViewModel.SaveBotAsync(value))
                {
                    saved = true;
                    return;
                }
                feedback.Title = "Could not save Bot";
                feedback.Message = ViewModel.StatusText;
                feedback.Severity = InfoBarSeverity.Error;
                feedback.IsOpen = true;
                args.Cancel = true;
            }
            finally
            {
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

    private sealed record ManagedBotDialogResult(Bot Bot, BotManagerAction Action);

    private sealed record ManagementFeedback(string Message, bool Succeeded)
    {
        public static ManagementFeedback Success(string message) => new(message, true);
        public static ManagementFeedback FromOperation(string message, bool succeeded) => new(message, succeeded);
    }
}
