using Amira.Contracts;
using Amira.Domain;
using Amira.Runtime;
using Microsoft.UI.Xaml.Automation.Peers;
using Microsoft.UI.Xaml.Controls;

namespace Amira.Client.WinUI.Tests;

public sealed class UserNoticeTests
{
    [Fact]
    public void Unknown_error_uses_error_severity_without_exposing_exception_details()
    {
        UserNotice notice = UserNotice.FromError(
            new InvalidOperationException("provider response contained api-key-secret"));

        Assert.Equal(UserNoticeSeverity.Error, notice.Severity);
        Assert.Equal("Something unexpected went wrong. Please try again.", notice.Message);
        Assert.DoesNotContain("provider response", notice.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("api-key-secret", notice.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Successful_notice_uses_success_severity()
    {
        UserNotice notice = UserNotice.Successful("Bot created.");

        Assert.Equal(UserNoticeSeverity.Success, notice.Severity);
        Assert.Equal("Bot created.", notice.Message);
    }

    [Fact]
    public async Task Dismiss_clears_notice_state_and_preserves_status_compatibility_text()
    {
        await using var session = new EmptyClientSession();
        var viewModel = new MainViewModel(session);

        await viewModel.SendAsync();
        string statusText = viewModel.StatusText;

        Assert.True(viewModel.HasNotice);
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);

        viewModel.DismissNotice();

        Assert.False(viewModel.HasNotice);
        Assert.Null(viewModel.Notice);
        Assert.Equal(statusText, viewModel.StatusText);
    }

    [Fact]
    public async Task Client_level_notice_can_surface_a_settings_failure()
    {
        await using var session = new EmptyClientSession();
        var viewModel = new MainViewModel(session);
        UserNotice notice = UserNotice.FromError(new Amira.Errors.AmiraException(new(
            Amira.Errors.AmiraErrorCodes.UiPreferencesSaveFailed,
            Amira.Errors.ErrorCategory.Persistence,
            "The interface settings could not be saved.")));

        viewModel.ShowNotice(notice);

        Assert.Same(notice, viewModel.Notice);
        Assert.Equal(notice.Message, viewModel.StatusText);
    }

    [Fact]
    public void Severity_converter_maps_typed_severity_to_infobar_severity()
    {
        var converter = new UserNoticeSeverityConverter();

        Assert.Equal(
            InfoBarSeverity.Success,
            converter.Convert(UserNoticeSeverity.Success, typeof(InfoBarSeverity), null!, string.Empty));
        Assert.Equal(
            InfoBarSeverity.Error,
            converter.Convert(UserNoticeSeverity.Error, typeof(InfoBarSeverity), null!, string.Empty));
        Assert.Equal(
            InfoBarSeverity.Informational,
            converter.Convert(null!, typeof(InfoBarSeverity), null!, string.Empty));
    }

    [Fact]
    public void Live_setting_converter_uses_polite_success_and_assertive_error_announcements()
    {
        var converter = new UserNoticeLiveSettingConverter();

        Assert.Equal(
            AutomationLiveSetting.Polite,
            converter.Convert(UserNoticeSeverity.Success, typeof(AutomationLiveSetting), null!, string.Empty));
        Assert.Equal(
            AutomationLiveSetting.Assertive,
            converter.Convert(UserNoticeSeverity.Error, typeof(AutomationLiveSetting), null!, string.Empty));
        Assert.Equal(
            AutomationLiveSetting.Off,
            converter.Convert(null!, typeof(AutomationLiveSetting), null!, string.Empty));
    }

    [Fact]
    public async Task Open_logs_success_publishes_a_success_notice()
    {
        await using var session = new EmptyClientSession();
        var viewModel = new MainViewModel(session, new FakeFolderLauncher(result: true));

        bool opened = await viewModel.OpenLogsFolderAsync();

        Assert.True(opened);
        Assert.Equal(UserNoticeSeverity.Success, viewModel.Notice?.Severity);
        Assert.Equal("Logs folder opened.", viewModel.Notice?.Message);
    }

    [Fact]
    public async Task Open_logs_failure_publishes_a_safe_error_notice_without_the_path()
    {
        await using var session = new EmptyClientSession();
        var viewModel = new MainViewModel(session, new FakeFolderLauncher(result: false));

        bool opened = await viewModel.OpenLogsFolderAsync();

        Assert.False(opened);
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Contains(Amira.Errors.AmiraErrorCodes.LogsFolderOpenFailed, viewModel.Notice?.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(session.LogsDirectory, viewModel.Notice?.Message ?? string.Empty, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task Open_logs_launcher_exception_is_safely_presented_without_its_details()
    {
        await using var session = new EmptyClientSession();
        var launcher = new FakeFolderLauncher(
            result: false,
            failure: new InvalidOperationException($"Explorer failed for {session.LogsDirectory} with secret details"));
        var viewModel = new MainViewModel(session, launcher);

        bool opened = await viewModel.OpenLogsFolderAsync();

        Assert.False(opened);
        Assert.Equal(UserNoticeSeverity.Error, viewModel.Notice?.Severity);
        Assert.Contains(Amira.Errors.AmiraErrorCodes.LogsFolderOpenFailed, viewModel.Notice?.Message, StringComparison.Ordinal);
        Assert.DoesNotContain(session.LogsDirectory, viewModel.Notice?.Message ?? string.Empty, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("secret details", viewModel.Notice?.Message ?? string.Empty, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class EmptyClientSession : IClientSession
    {
        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();
        public string LogsDirectory { get; } = @"D:\private\amira\logs";

        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<Bot>>([]);

        public ValueTask<IReadOnlyList<ProviderConnection>> ListConnectionsAsync(CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<IReadOnlyList<ProviderConnection>>([]);

        public ValueTask<ProviderConnection> CreateProviderConnectionAsync(ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<ProviderConnection> UpdateProviderConnectionAsync(ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel, bool enabled, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }

    private sealed class FakeFolderLauncher(bool result, Exception? failure = null) : IFolderLauncher
    {
        public ValueTask<bool> LaunchAsync(string folderPath) => failure is null
            ? ValueTask.FromResult(result)
            : ValueTask.FromException<bool>(failure);
    }
}
