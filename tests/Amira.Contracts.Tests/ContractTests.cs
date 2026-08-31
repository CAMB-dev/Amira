using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using System.Diagnostics;

namespace Amira.Contracts.Tests;

public sealed class ContractTests
{
    [Fact]
    public void Human_message_command_preserves_exact_content()
    {
        Bot bot = CreateBot();
        ModelProfileSnapshot snapshot = bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible);
        const string content = "  hello\nworld  ";

        var command = new HumanMessageCommand(bot.DirectChatId, content, bot.Id, snapshot);

        Assert.Equal(content, command.Content);
    }

    [Fact]
    public void Provider_stream_vocabulary_has_unambiguous_usage_event()
    {
        ModelStreamEvent usage = new ModelStreamEvent.Usage(new ProviderUsage(3, 5));

        Assert.Equal(5, Assert.IsType<ModelStreamEvent.Usage>(usage).Value.OutputTokens);
        Assert.Equal("provider.request", AmiraTelemetry.ProviderRequestActivity);
        Assert.Equal("turn.execute", AmiraTelemetry.TurnExecuteActivity);
        Assert.Equal("Amira.Runtime", AmiraTelemetry.ActivitySourceName);
        Assert.Equal("Amira.Runtime", AmiraTelemetry.MeterName);
        Assert.Equal(1200, (int)AmiraLogEvent.ProviderRequestStarted);
        Assert.Equal("amira.provider.request.count", AmiraTelemetry.Metrics.ProviderRequestCount);
    }

    [Fact]
    public void Durable_turn_contract_round_trips_optional_activity_context_without_domain_coupling()
    {
        Bot bot = CreateBot();
        var parent = new ActivityContext(
            ActivityTraceId.CreateRandom(),
            ActivitySpanId.CreateRandom(),
            ActivityTraceFlags.Recorded,
            "vendor=value",
            true);
        var command = new HumanMessageCommand(
            bot.DirectChatId,
            "hello",
            bot.Id,
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible),
            parent);
        BotTurn turn = BotTurn.Queue(
            bot.Id,
            bot.DirectChatId,
            [MessageId.New()],
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible));
        var claimed = new ClaimedTurn(turn.Start(), TurnClaimToken.New(), command.ParentActivityContext);

        Assert.Equal(parent, claimed.ParentActivityContext);
        Assert.Equal(default, new HumanMessageCommand(
            bot.DirectChatId,
            "hello",
            bot.Id,
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible)).ParentActivityContext);
    }

    [Fact]
    public void Contract_identifier_validation_uses_typed_input_error()
    {
        AmiraException exception = Assert.Throws<AmiraException>(() => new TurnClaimToken(" "));
        Assert.Equal(ErrorCategory.Input, exception.Category);
    }

    [Fact]
    public void Request_connection_mismatch_uses_typed_domain_error()
    {
        Bot bot = CreateBot();
        var request = new ModelRequest(
            WorkspaceId.New(),
            bot.Id,
            bot.DirectChatId,
            BotTurnId.New(),
            bot.ModelProfile.Snapshot(ProviderProtocol.OpenAIChatCompatible),
            [new ModelMessage(ModelMessageRole.User, "hello")]);
        ProviderConnection wrong = ProviderConnection.Create(
            ProviderProtocol.AnthropicMessages,
            "wrong",
            new Uri("https://example.test"),
            CredentialReference.Create("wrong"));

        AmiraException exception = Assert.Throws<AmiraException>(() => request.ValidateConnection(wrong));

        Assert.Equal("snapshot_mismatch", exception.Code);
        Assert.Equal(ErrorCategory.DomainRule, exception.Category);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(101)]
    public void Turn_query_rejects_invalid_page_size_as_product_input(int pageSize)
    {
        AmiraException exception = Assert.Throws<AmiraException>(() => new TurnQuery(pageSize: pageSize));

        Assert.Equal(AmiraErrorCodes.InvalidTurnQuery, exception.Code);
        Assert.Equal(ErrorCategory.Input, exception.Category);
    }

    [Fact]
    public void Turn_query_has_bounded_defaults_and_rejects_invalid_cursor()
    {
        var defaultQuery = new TurnQuery();
        var maximumQuery = new TurnQuery(pageSize: TurnQuery.MaximumPageSize);

        Assert.Equal(TurnQuery.DefaultPageSize, defaultQuery.PageSize);
        Assert.Equal(TurnQuery.MaximumPageSize, maximumQuery.PageSize);

        AmiraException exception = Assert.Throws<AmiraException>(() =>
            new TurnQuery(before: new TurnCursor(DateTimeOffset.UtcNow, default)));
        Assert.Equal(AmiraErrorCodes.InvalidTurnQuery, exception.Code);
        Assert.Equal(ErrorCategory.Input, exception.Category);
    }

    [Fact]
    public void Turn_query_rejects_invalid_filters_as_product_input()
    {
        AmiraException bot = Assert.Throws<AmiraException>(() => new TurnQuery(botId: default(BotId)));
        AmiraException chat = Assert.Throws<AmiraException>(() => new TurnQuery(chatId: default(DirectChatId)));
        AmiraException status = Assert.Throws<AmiraException>(() => new TurnQuery(status: (BotTurnStatus)999));

        Assert.All([bot, chat, status], exception =>
        {
            Assert.Equal(AmiraErrorCodes.InvalidTurnQuery, exception.Code);
            Assert.Equal(ErrorCategory.Input, exception.Category);
        });
    }

    [Fact]
    public void Turn_view_projects_full_timing_and_reported_token_total()
    {
        DateTimeOffset queuedAt = DateTimeOffset.UnixEpoch;
        DateTimeOffset startedAt = queuedAt.AddSeconds(4);
        DateTimeOffset firstTokenAt = startedAt.AddMilliseconds(750);
        DateTimeOffset finishedAt = firstTokenAt.AddSeconds(6);
        TurnView view = CreateTurnView(queuedAt, startedAt, firstTokenAt, finishedAt, new TurnUsage(13, 8));

        Assert.Equal(TimeSpan.FromSeconds(4), view.QueueWaitDuration);
        Assert.Equal(TimeSpan.FromMilliseconds(750), view.TimeToFirstToken);
        Assert.Equal(TimeSpan.FromSeconds(6), view.GenerationDuration);
        Assert.Equal(TimeSpan.FromMilliseconds(10_750), view.EndToEndDuration);
        Assert.Equal(21, view.Usage?.TotalTokens);
    }

    [Theory]
    [InlineData(13, null)]
    [InlineData(null, 8)]
    public void Turn_usage_leaves_total_unknown_when_either_component_is_missing(int? inputTokens, int? outputTokens)
    {
        var usage = new TurnUsage(inputTokens, outputTokens);

        Assert.Null(usage.TotalTokens);
    }

    [Fact]
    public void Turn_view_leaves_token_timings_unknown_when_no_text_delta_was_observed()
    {
        DateTimeOffset queuedAt = DateTimeOffset.UnixEpoch;
        DateTimeOffset startedAt = queuedAt.AddSeconds(4);
        DateTimeOffset finishedAt = startedAt.AddSeconds(2);
        TurnView view = CreateTurnView(queuedAt, startedAt, firstTokenAt: null, finishedAt, usage: null);

        Assert.Equal(TimeSpan.FromSeconds(4), view.QueueWaitDuration);
        Assert.Null(view.TimeToFirstToken);
        Assert.Null(view.GenerationDuration);
        Assert.Equal(TimeSpan.FromSeconds(6), view.EndToEndDuration);
    }

    private static TurnView CreateTurnView(
        DateTimeOffset queuedAt,
        DateTimeOffset? startedAt,
        DateTimeOffset? firstTokenAt,
        DateTimeOffset? finishedAt,
        TurnUsage? usage) => new(
            BotTurnId.New(),
            BotId.New(),
            DirectChatId.New(),
            ModelProfileId.New(),
            ProviderConnectionId.New(),
            ProviderProtocol.OpenAIResponses,
            "model",
            1,
            BotTurnStatus.Completed,
            queuedAt,
            startedAt,
            firstTokenAt,
            finishedAt,
            false,
            null,
            null,
            usage);

    private static Bot CreateBot() =>
        Bot.Create(BotProfile.Create("Amira"), ModelProfile.Create(ProviderConnectionId.New(), "model"));
}
