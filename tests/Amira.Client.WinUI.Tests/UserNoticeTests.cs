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

    private sealed class EmptyClientSession : IClientSession
    {
        public WorkspaceId WorkspaceId { get; } = WorkspaceId.New();

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
        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<QueuedMessageResult> SendAsync(BotId botId, string content, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<BotTurn> RetryAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<StopResult> StopTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}
