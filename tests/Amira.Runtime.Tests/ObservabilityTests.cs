using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Runtime.CompilerServices;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;
using Microsoft.Extensions.Logging;

namespace Amira.Runtime.Tests;

public sealed partial class RuntimeTests
{
    private const string ParentSourceName = "Amira.Runtime.Tests.Parent";

    [Fact]
    public async Task Provider_request_keeps_the_queued_trace_across_worker_and_retry_boundaries()
    {
        using var telemetry = new TelemetryCollector();
        using var parentSource = new ActivitySource(ParentSourceName);
        Activity? previous = Activity.Current;

        try
        {
            using Activity parent = parentSource.StartActivity("incoming", ActivityKind.Server)
                ?? throw new InvalidOperationException("The test ActivityListener did not sample the parent activity.");
            ActivityTraceId expectedTraceId = parent.TraceId;
            var fixture = new Fixture();
            QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
                fixture.WorkspaceId,
                fixture.Bot.Id,
                "hello",
                TestContext.Current.CancellationToken);
            parent.Stop();
            Activity.Current = null;

            await CollectWithoutRuntimeActivity(fixture.Runtime.ExecuteNextAsync(
                fixture.WorkspaceId,
                fixture.Bot.Id,
                TestContext.Current.CancellationToken));
            await fixture.Runtime.RetryAsync(queued.Turn.Id, TestContext.Current.CancellationToken);
            await CollectWithoutRuntimeActivity(fixture.Runtime.ExecuteNextAsync(
                fixture.WorkspaceId,
                fixture.Bot.Id,
                TestContext.Current.CancellationToken));

            ActivitySnapshot[] commits = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.MessageCommitActivity)];
            Assert.Equal(3, commits.Length);
            ActivitySnapshot initialCommit = Assert.Single(commits, item => item.ParentSpanId == parent.SpanId);
            Assert.Equal(ActivityStatusCode.Ok, initialCommit.Status);
            Assert.Equal(AmiraTelemetry.Outcomes.Success, initialCommit.Tags[AmiraTelemetry.Tags.Outcome]);
            ActivitySnapshot queue = Assert.Single(telemetry.Activities, static item => item.Name == AmiraTelemetry.TurnQueueActivity);
            Assert.Equal(initialCommit.SpanId, queue.ParentSpanId);
            Assert.Equal(ActivityStatusCode.Ok, queue.Status);
            ActivitySnapshot[] turns = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.TurnExecuteActivity)];
            ActivitySnapshot[] contexts = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ContextBuildActivity)];
            ActivitySnapshot[] requests = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ProviderRequestActivity)];
            ActivitySnapshot[] streams = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ProviderStreamActivity)];
            Assert.Equal(2, turns.Length);
            Assert.Equal(2, contexts.Length);
            Assert.Equal(2, requests.Length);
            Assert.Equal(2, streams.Length);
            Assert.All(telemetry.Activities, activity =>
            {
                Assert.Equal(expectedTraceId, activity.TraceId);
                AssertTurnIdentity(activity);
            });
            Assert.All(turns, turn =>
            {
                Assert.Equal(initialCommit.SpanId, turn.ParentSpanId);
                Assert.Equal(AmiraTelemetry.Outcomes.Success, turn.Tags[AmiraTelemetry.Tags.Outcome]);
                string turnId = turn.Tags[AmiraTelemetry.Tags.TurnId];
                ActivitySnapshot context = Assert.Single(contexts, item => item.Tags[AmiraTelemetry.Tags.TurnId] == turnId);
                ActivitySnapshot request = Assert.Single(requests, item => item.Tags[AmiraTelemetry.Tags.TurnId] == turnId);
                Assert.Equal(turn.SpanId, context.ParentSpanId);
                Assert.Equal(turn.SpanId, request.ParentSpanId);
                ActivitySnapshot stream = Assert.Single(streams, item => item.Tags[AmiraTelemetry.Tags.TurnId] == turnId);
                Assert.Equal(request.SpanId, stream.ParentSpanId);
                ActivitySnapshot assistantCommit = Assert.Single(commits, item => item.ParentSpanId == request.SpanId);
                Assert.Equal(turnId, assistantCommit.Tags[AmiraTelemetry.Tags.TurnId]);
            });
        }
        finally
        {
            Activity.Current = previous;
        }
    }

    [Fact]
    public async Task Pre_provider_failure_is_correlated_without_an_ambient_activity()
    {
        using var telemetry = new TelemetryCollector();
        var logger = new CapturingLogger();
        var fixture = new Fixture();
        var runtime = new BasicChatRuntime(
            fixture.Store,
            fixture.Store,
            new ProviderRegistry(),
            logger: logger);
        Activity? previous = Activity.Current;

        try
        {
            Activity.Current = null;
            QueuedMessageResult queued = await runtime.QueueHumanMessageAsync(
                fixture.WorkspaceId,
                fixture.Bot.Id,
                "safe prompt",
                TestContext.Current.CancellationToken);
            List<ChatRuntimeEvent> events = await CollectWithoutRuntimeActivity(runtime.ExecuteNextAsync(
                fixture.WorkspaceId,
                fixture.Bot.Id,
                TestContext.Current.CancellationToken));

            ChatRuntimeEvent.Failed failed = Assert.IsType<ChatRuntimeEvent.Failed>(events[^1]);
            Assert.Equal(AmiraErrorCodes.ProviderUnavailable, failed.Failure.Code);
            Assert.Equal(ErrorCategory.Configuration, failed.Failure.Category);
            Assert.DoesNotContain(
                telemetry.Activities,
                static activity => activity.Name is AmiraTelemetry.ProviderRequestActivity or AmiraTelemetry.ProviderStreamActivity);

            ActivitySnapshot turn = Assert.Single(
                telemetry.Activities,
                activity => activity.Name == AmiraTelemetry.TurnExecuteActivity
                    && activity.Tags[AmiraTelemetry.Tags.TurnId] == queued.Turn.Id.Value);
            Assert.Equal(ActivityStatusCode.Error, turn.Status);
            Assert.Equal(AmiraErrorCodes.ProviderUnavailable, turn.Tags[AmiraTelemetry.Tags.ErrorCode]);
            Assert.Equal(ErrorCategory.Configuration.ToString(), turn.Tags[AmiraTelemetry.Tags.ErrorCategory]);

            LogSnapshot claimed = Assert.Single(
                logger.Entries,
                static entry => entry.EventId.Id == (int)AmiraLogEvent.TurnClaimed);
            LogSnapshot terminal = Assert.Single(
                logger.Entries,
                static entry => entry.EventId.Id == (int)AmiraLogEvent.TurnFailed);
            Assert.Equal(LogLevel.Information, claimed.Level);
            Assert.Equal(LogLevel.Warning, terminal.Level);
            Assert.Equal(turn.TraceId, claimed.TraceId);
            Assert.Equal(turn.TraceId, terminal.TraceId);
            Assert.NotEqual(default, terminal.TraceId);
            Assert.Equal(AmiraErrorCodes.ProviderUnavailable, FindProperty(terminal, "ErrorCode"));
            Assert.Equal(ErrorCategory.Configuration.ToString(), FindProperty(terminal, "ErrorCategory"));
            AssertTurnIdentity(claimed);
            AssertTurnIdentity(terminal);
        }
        finally
        {
            Activity.Current = previous;
        }
    }

    [Fact]
    public async Task Provider_observability_has_stable_outcomes_event_ids_and_no_sensitive_values()
    {
        const string promptCanary = "PROMPT_CANARY_82F0";
        const string responseCanary = "RESPONSE_CANARY_71A9";
        const string credentialCanary = "CREDENTIAL_REF_CANARY_43D1";
        const string headerNameCanary = "X-HEADER-CANARY-19B7";
        const string headerValueCanary = "HEADER_VALUE_CANARY_5C22";
        const string providerErrorCanary = "PROVIDER_ERROR_CANARY_6E34";
        using var telemetry = new TelemetryCollector();
        using var meterFactory = new TestMeterFactory();
        var logger = new CapturingLogger();
        IReadOnlyDictionary<string, string> headers = new Dictionary<string, string>
        {
            [headerNameCanary] = headerValueCanary
        };

        var success = new Fixture(
            new FakeProvider(
                new ModelStreamEvent.Started(),
                new ModelStreamEvent.TextDelta(responseCanary),
                new ModelStreamEvent.Usage(new ProviderUsage(11, 13)),
                new ModelStreamEvent.Completed()),
            logger: logger,
            meterFactory: meterFactory,
            credentialReference: credentialCanary,
            extraHeaders: headers);
        await success.Runtime.QueueHumanMessageAsync(success.WorkspaceId, success.Bot.Id, promptCanary, TestContext.Current.CancellationToken);
        await Collect(success.Runtime.ExecuteNextAsync(success.WorkspaceId, success.Bot.Id, TestContext.Current.CancellationToken));

        var failure = new Fixture(
            new FakeProvider(new AmiraException(new AmiraError(
                "provider_bad",
                ErrorCategory.Provider,
                providerErrorCanary,
                true))),
            logger: logger,
            meterFactory: meterFactory,
            credentialReference: credentialCanary,
            extraHeaders: headers);
        await failure.Runtime.QueueHumanMessageAsync(failure.WorkspaceId, failure.Bot.Id, promptCanary, TestContext.Current.CancellationToken);
        await Collect(failure.Runtime.ExecuteNextAsync(failure.WorkspaceId, failure.Bot.Id, TestContext.Current.CancellationToken));

        var blockingProvider = new BlockingProvider();
        var cancelled = new Fixture(
            blockingProvider,
            logger: logger,
            meterFactory: meterFactory,
            credentialReference: credentialCanary,
            extraHeaders: headers);
        await cancelled.Runtime.QueueHumanMessageAsync(cancelled.WorkspaceId, cancelled.Bot.Id, promptCanary, TestContext.Current.CancellationToken);
        Task<List<ChatRuntimeEvent>> execution = Collect(cancelled.Runtime.ExecuteNextAsync(
            cancelled.WorkspaceId,
            cancelled.Bot.Id,
            TestContext.Current.CancellationToken));
        await blockingProvider.Started.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
        await cancelled.Runtime.StopAsync(blockingProvider.TurnId, TestContext.Current.CancellationToken);
        await execution.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);

        ActivitySnapshot[] requests = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ProviderRequestActivity)];
        Assert.Equal(3, requests.Length);
        ActivitySnapshot succeeded = Assert.Single(requests, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Success);
        ActivitySnapshot failed = Assert.Single(requests, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Failure);
        ActivitySnapshot stopped = Assert.Single(requests, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Cancelled);
        Assert.Equal(ActivityStatusCode.Ok, succeeded.Status);
        Assert.False(succeeded.Tags.ContainsKey(AmiraTelemetry.Tags.ErrorCode));
        Assert.Equal(ActivityStatusCode.Error, failed.Status);
        Assert.Equal("provider_bad", failed.Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(ErrorCategory.Provider.ToString(), failed.Tags[AmiraTelemetry.Tags.ErrorCategory]);
        Assert.Equal(ActivityStatusCode.Error, stopped.Status);
        Assert.Equal(AmiraTelemetry.ErrorCodes.OperationCancelled, stopped.Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(ErrorCategory.Concurrency.ToString(), stopped.Tags[AmiraTelemetry.Tags.ErrorCategory]);

        ActivitySnapshot[] streams = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ProviderStreamActivity)];
        Assert.Equal(3, streams.Length);
        Assert.Equal(
            ErrorCategory.Provider.ToString(),
            Assert.Single(streams, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Failure)
                .Tags[AmiraTelemetry.Tags.ErrorCategory]);
        Assert.Equal(
            ErrorCategory.Concurrency.ToString(),
            Assert.Single(streams, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Cancelled)
                .Tags[AmiraTelemetry.Tags.ErrorCategory]);

        ActivitySnapshot[] turns = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.TurnExecuteActivity)];
        Assert.Equal(3, turns.Length);
        Assert.Equal(ActivityStatusCode.Ok, Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Success).Status);
        ActivitySnapshot failedTurn = Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Failure);
        Assert.Equal("provider_bad", failedTurn.Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(ErrorCategory.Provider.ToString(), failedTurn.Tags[AmiraTelemetry.Tags.ErrorCategory]);
        ActivitySnapshot cancelledTurn = Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Cancelled);
        Assert.Equal(AmiraTelemetry.ErrorCodes.OperationCancelled, cancelledTurn.Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(ErrorCategory.Concurrency.ToString(), cancelledTurn.Tags[AmiraTelemetry.Tags.ErrorCategory]);

        MeasurementSnapshot[] requestCounts = [.. telemetry.Measurements.Where(static item => item.Name == AmiraTelemetry.Metrics.ProviderRequestCount)];
        Assert.Equal(3, requestCounts.Length);
        Assert.Equal(
            [AmiraTelemetry.Outcomes.Cancelled, AmiraTelemetry.Outcomes.Failure, AmiraTelemetry.Outcomes.Success],
            requestCounts.Select(item => item.Tags[AmiraTelemetry.Tags.Outcome]).Order(StringComparer.Ordinal));
        Assert.Equal(3, telemetry.Measurements.Count(static item => item.Name == AmiraTelemetry.Metrics.ProviderRequestDuration));
        Assert.Equal(2, telemetry.Measurements.Count(static item => item.Name == AmiraTelemetry.Metrics.ProviderTimeToFirstToken));
        Assert.Equal(11d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.ProviderInputTokens).Value);
        Assert.Equal(13d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.ProviderOutputTokens).Value);
        MeasurementSnapshot[] providerMeasurements = [.. telemetry.Measurements.Where(static measurement => measurement.Name.StartsWith("amira.provider.", StringComparison.Ordinal))];
        Assert.All(providerMeasurements, measurement =>
        {
            Assert.Equal(2, measurement.Tags.Count);
            Assert.Contains(AmiraTelemetry.Tags.ProviderProtocol, measurement.Tags.Keys);
            Assert.Contains(AmiraTelemetry.Tags.Outcome, measurement.Tags.Keys);
        });

        Assert.Equal(3, telemetry.Measurements.Count(static item => item.Name == AmiraTelemetry.Metrics.TurnQueuedTotal && item.Value == 1d));
        MeasurementSnapshot[] activeTurns = [.. telemetry.Measurements.Where(static item => item.Name == AmiraTelemetry.Metrics.ActiveTurns)];
        Assert.Equal(6, activeTurns.Length);
        Assert.Equal(3, activeTurns.Count(static item => item.Value == 1d));
        Assert.Equal(3, activeTurns.Count(static item => item.Value == -1d));
        Assert.All(activeTurns, static item => Assert.Empty(item.Tags));
        Assert.Equal(1d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.TurnStopRequestedTotal).Value);
        Assert.Equal(1d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.TurnCancelledTotal).Value);

        int[] eventIds = [.. logger.Entries.Select(static entry => entry.EventId.Id)];
        Assert.Contains((int)AmiraLogEvent.ProviderRequestStarted, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestCompleted, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestFailed, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestCancelled, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnCompleted, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnFailed, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnCancelled, eventIds);

        int[] lifecycleEventIds =
        [
            (int)AmiraLogEvent.MessageCommitted,
            (int)AmiraLogEvent.TurnQueued,
            (int)AmiraLogEvent.TurnClaimed,
            (int)AmiraLogEvent.TurnCompleted,
            (int)AmiraLogEvent.TurnFailed,
            (int)AmiraLogEvent.TurnCancelled,
            (int)AmiraLogEvent.ProviderRequestStarted,
            (int)AmiraLogEvent.ProviderRequestCompleted,
            (int)AmiraLogEvent.ProviderRequestFailed,
            (int)AmiraLogEvent.ProviderRequestCancelled,
            (int)AmiraLogEvent.ContextBuilt,
        ];
        LogSnapshot[] lifecycleLogs = [.. logger.Entries.Where(entry => lifecycleEventIds.Contains(entry.EventId.Id))];
        Assert.NotEmpty(lifecycleLogs);
        Assert.All(lifecycleLogs, AssertTurnIdentity);

        LogSnapshot completedRequest = Assert.Single(
            lifecycleLogs,
            static entry => entry.EventId.Id == (int)AmiraLogEvent.ProviderRequestCompleted);
        Assert.Equal(LogLevel.Information, completedRequest.Level);
        Assert.IsType<double>(FindProperty(completedRequest, "DurationMs"));
        Assert.Equal(11, FindProperty(completedRequest, "UsageInput"));
        Assert.Equal(13, FindProperty(completedRequest, "UsageOutput"));
        Assert.Null(FindProperty(completedRequest, "ErrorCode"));
        Assert.Null(FindProperty(completedRequest, "ErrorCategory"));

        LogSnapshot failedRequest = Assert.Single(
            lifecycleLogs,
            static entry => entry.EventId.Id == (int)AmiraLogEvent.ProviderRequestFailed);
        Assert.Equal(LogLevel.Warning, failedRequest.Level);
        Assert.Equal("provider_bad", FindProperty(failedRequest, "ErrorCode"));
        Assert.Equal(ErrorCategory.Provider.ToString(), FindProperty(failedRequest, "ErrorCategory"));
        Assert.Null(FindProperty(failedRequest, "UsageInput"));
        Assert.Null(FindProperty(failedRequest, "UsageOutput"));

        LogSnapshot cancelledRequest = Assert.Single(
            lifecycleLogs,
            static entry => entry.EventId.Id == (int)AmiraLogEvent.ProviderRequestCancelled);
        Assert.Equal(LogLevel.Information, cancelledRequest.Level);
        Assert.Equal(AmiraTelemetry.ErrorCodes.OperationCancelled, FindProperty(cancelledRequest, "ErrorCode"));
        Assert.Equal(ErrorCategory.Concurrency.ToString(), FindProperty(cancelledRequest, "ErrorCategory"));

        Assert.Equal(
            LogLevel.Warning,
            Assert.Single(lifecycleLogs, static entry => entry.EventId.Id == (int)AmiraLogEvent.TurnFailed).Level);
        Assert.All(
            lifecycleLogs.Where(static entry => entry.EventId.Id is (int)AmiraLogEvent.TurnCompleted or (int)AmiraLogEvent.TurnCancelled),
            static entry => Assert.Equal(LogLevel.Information, entry.Level));

        string exportedText = string.Join("\n", [
            .. logger.Entries.SelectMany(static entry => entry.ExportValues()),
            .. telemetry.Activities.SelectMany(static activity => activity.Tags.Select(static pair => $"{pair.Key}={pair.Value}")),
            .. telemetry.Measurements.SelectMany(static measurement => measurement.Tags.Select(static pair => $"{pair.Key}={pair.Value}"))
        ]);
        Assert.DoesNotContain(promptCanary, exportedText, StringComparison.Ordinal);
        Assert.DoesNotContain(responseCanary, exportedText, StringComparison.Ordinal);
        Assert.DoesNotContain(credentialCanary, exportedText, StringComparison.Ordinal);
        Assert.DoesNotContain(headerNameCanary, exportedText, StringComparison.Ordinal);
        Assert.DoesNotContain(headerValueCanary, exportedText, StringComparison.Ordinal);
        Assert.DoesNotContain(providerErrorCanary, exportedText, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Queued_turn_stop_counts_one_durable_stop_and_one_terminal_cancellation()
    {
        using var telemetry = new TelemetryCollector();
        using var meterFactory = new TestMeterFactory();
        var fixture = new Fixture(meterFactory: meterFactory);

        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "hello",
            TestContext.Current.CancellationToken);
        StopResult first = await fixture.Runtime.StopAsync(queued.Turn.Id, TestContext.Current.CancellationToken);
        StopResult second = await fixture.Runtime.StopAsync(queued.Turn.Id, TestContext.Current.CancellationToken);

        Assert.True(first.DurableStopRequested);
        Assert.False(second.DurableStopRequested);
        Assert.Equal(1d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.TurnQueuedTotal).Value);
        Assert.Equal(1d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.TurnStopRequestedTotal).Value);
        Assert.Equal(1d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.TurnCancelledTotal).Value);
        Assert.DoesNotContain(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.ActiveTurns);
    }

    [Fact]
    public async Task Retry_creates_another_durable_queued_turn_measurement()
    {
        using var telemetry = new TelemetryCollector();
        using var meterFactory = new TestMeterFactory();
        var fixture = new Fixture(
            new FakeProvider(new AmiraException(new AmiraError("retryable", ErrorCategory.Provider, "retry", true))),
            meterFactory: meterFactory);

        QueuedMessageResult queued = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "hello",
            TestContext.Current.CancellationToken);
        await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));
        _ = await fixture.Runtime.RetryAsync(queued.Turn.Id, TestContext.Current.CancellationToken);

        Assert.Equal(2, telemetry.Measurements.Count(static item =>
            item.Name == AmiraTelemetry.Metrics.TurnQueuedTotal && item.Value == 1d));
    }

    [Fact]
    public async Task Queued_turn_gauge_tracks_new_claimed_cancelled_and_recovered_turns()
    {
        using var telemetry = new TelemetryCollector();
        using var meterFactory = new TestMeterFactory();
        var fixture = new Fixture(
            new FakeProvider(new AmiraException(new AmiraError("retryable", ErrorCategory.Provider, "retry", true))),
            meterFactory: meterFactory);

        QueuedMessageResult initial = await fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "initial",
            TestContext.Current.CancellationToken);
        AssertQueuedTurns(telemetry, 1);

        await Collect(fixture.Runtime.ExecuteNextAsync(fixture.WorkspaceId, fixture.Bot.Id, TestContext.Current.CancellationToken));
        AssertQueuedTurns(telemetry, 0);

        BotTurn retry = await fixture.Runtime.RetryAsync(initial.Turn.Id, TestContext.Current.CancellationToken);
        AssertQueuedTurns(telemetry, 1);

        StopResult stop = await fixture.Runtime.StopAsync(retry.Id, TestContext.Current.CancellationToken);
        Assert.True(stop.DurableStopRequested);
        AssertQueuedTurns(telemetry, 0);

        for (int index = 0; index <= TurnQuery.MaximumPageSize; index++)
        {
            _ = await fixture.Store.CommitHumanMessageAndQueueTurnAsync(
                new HumanMessageCommand(
                    fixture.Bot.DirectChatId,
                    $"recovered-{index}",
                    fixture.Bot.Id,
                    fixture.Bot.ModelProfile.Snapshot(fixture.Provider.Protocol)),
                TestContext.Current.CancellationToken);
        }
        await fixture.Runtime.RecoverInterruptedTurnsAsync(TestContext.Current.CancellationToken);
        AssertQueuedTurns(telemetry, TurnQuery.MaximumPageSize + 1);
    }

    [Fact]
    public async Task Message_commit_typed_failure_records_only_its_stable_code()
    {
        const string failureCanary = "COMMIT_FAILURE_CANARY_47C8";
        using var telemetry = new TelemetryCollector();
        var fixture = new Fixture();
        fixture.Store.CommitFailure = new AmiraException(new AmiraError(
            "commit_failed",
            ErrorCategory.Persistence,
            failureCanary));

        await Assert.ThrowsAsync<AmiraException>(() => fixture.Runtime.QueueHumanMessageAsync(
            fixture.WorkspaceId,
            fixture.Bot.Id,
            "message",
            TestContext.Current.CancellationToken).AsTask());

        ActivitySnapshot commit = Assert.Single(telemetry.Activities, static item => item.Name == AmiraTelemetry.MessageCommitActivity);
        Assert.Equal(ActivityStatusCode.Error, commit.Status);
        Assert.Equal(AmiraTelemetry.Outcomes.Failure, commit.Tags[AmiraTelemetry.Tags.Outcome]);
        Assert.Equal("commit_failed", commit.Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(ErrorCategory.Persistence.ToString(), commit.Tags[AmiraTelemetry.Tags.ErrorCategory]);
        Assert.DoesNotContain(failureCanary, string.Join("\n", commit.Tags.Values), StringComparison.Ordinal);
    }

    private static async Task<List<ChatRuntimeEvent>> CollectWithoutRuntimeActivity(IAsyncEnumerable<ChatRuntimeEvent> source)
    {
        var events = new List<ChatRuntimeEvent>();
        await foreach (ChatRuntimeEvent item in source)
        {
            Assert.Null(Activity.Current);
            events.Add(item);
        }
        Assert.Null(Activity.Current);
        return events;
    }

    private static void AssertTurnIdentity(ActivitySnapshot activity)
    {
        Assert.False(string.IsNullOrWhiteSpace(activity.Tags[AmiraTelemetry.Tags.BotId]));
        Assert.False(string.IsNullOrWhiteSpace(activity.Tags[AmiraTelemetry.Tags.ChatId]));
        Assert.False(string.IsNullOrWhiteSpace(activity.Tags[AmiraTelemetry.Tags.TurnId]));
        Assert.False(string.IsNullOrWhiteSpace(activity.Tags[AmiraTelemetry.Tags.ProviderProtocol]));
        Assert.False(string.IsNullOrWhiteSpace(activity.Tags[AmiraTelemetry.Tags.Model]));
    }

    private static void AssertTurnIdentity(LogSnapshot entry)
    {
        Assert.False(string.IsNullOrWhiteSpace(FindProperty(entry, "BotId")?.ToString()));
        Assert.False(string.IsNullOrWhiteSpace(FindProperty(entry, "ChatId")?.ToString()));
        Assert.False(string.IsNullOrWhiteSpace(FindProperty(entry, "TurnId")?.ToString()));
        Assert.False(string.IsNullOrWhiteSpace(FindProperty(entry, "ProviderProtocol")?.ToString()));
        Assert.False(string.IsNullOrWhiteSpace(FindProperty(entry, "Model")?.ToString()));
    }

    private static object? FindProperty(LogSnapshot entry, string name) =>
        Assert.Single(entry.Properties, property => property.Key == name).Value;

    private static void AssertQueuedTurns(TelemetryCollector telemetry, double expected)
    {
        telemetry.RecordObservableInstruments();
        Assert.Equal(expected, telemetry.Measurements.Last(static item => item.Name == AmiraTelemetry.Metrics.QueuedTurns).Value);
    }

    private sealed class TelemetryCollector : IDisposable
    {
        private readonly ActivityListener _activityListener;
        private readonly MeterListener _meterListener;

        public TelemetryCollector()
        {
            _activityListener = new ActivityListener
            {
                ShouldListenTo = static source => source.Name is AmiraTelemetry.ActivitySourceName or ParentSourceName,
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStopped = activity =>
                {
                    if (activity.Source.Name != AmiraTelemetry.ActivitySourceName) return;
                    Activities.Add(new ActivitySnapshot(
                        activity.OperationName,
                        activity.TraceId,
                        activity.SpanId,
                        activity.ParentSpanId,
                        activity.Status,
                        CopyTags(activity.TagObjects)));
                }
            };
            ActivitySource.AddActivityListener(_activityListener);

            _meterListener = new MeterListener
            {
                InstrumentPublished = static (instrument, listener) =>
                {
                    if (instrument.Meter.Name == AmiraTelemetry.MeterName)
                        listener.EnableMeasurementEvents(instrument);
                }
            };
            _meterListener.SetMeasurementEventCallback<long>((instrument, value, tags, _) =>
                Measurements.Add(new MeasurementSnapshot(instrument.Name, value, CopyTags(tags))));
            _meterListener.SetMeasurementEventCallback<double>((instrument, value, tags, _) =>
                Measurements.Add(new MeasurementSnapshot(instrument.Name, value, CopyTags(tags))));
            _meterListener.Start();
        }

        public List<ActivitySnapshot> Activities { get; } = [];
        public List<MeasurementSnapshot> Measurements { get; } = [];

        public void RecordObservableInstruments() => _meterListener.RecordObservableInstruments();

        public void Dispose()
        {
            _meterListener.Dispose();
            _activityListener.Dispose();
        }

        private static IReadOnlyDictionary<string, string> CopyTags(IEnumerable<KeyValuePair<string, object?>> tags)
        {
            var copy = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object?> tag in tags)
                copy[tag.Key] = tag.Value?.ToString() ?? string.Empty;
            return copy;
        }

        private static IReadOnlyDictionary<string, string> CopyTags(ReadOnlySpan<KeyValuePair<string, object?>> tags)
        {
            var copy = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (KeyValuePair<string, object?> tag in tags)
                copy[tag.Key] = tag.Value?.ToString() ?? string.Empty;
            return copy;
        }
    }

    private sealed class TestMeterFactory : IMeterFactory
    {
        private readonly List<Meter> _meters = [];

        public Meter Create(MeterOptions options)
        {
            var meter = new Meter(options);
            _meters.Add(meter);
            return meter;
        }

        public void Dispose()
        {
            foreach (Meter meter in _meters) meter.Dispose();
        }
    }

    private sealed class CapturingLogger : ILogger
    {
        public List<LogSnapshot> Entries { get; } = [];

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => NoopScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            IReadOnlyList<KeyValuePair<string, object?>> properties = state is IEnumerable<KeyValuePair<string, object?>> values
                ? [.. values]
                : [];
            Entries.Add(new LogSnapshot(
                logLevel,
                eventId,
                Activity.Current?.TraceId ?? default,
                formatter(state, exception),
                properties,
                exception?.ToString()));
        }
    }

    private sealed class NoopScope : IDisposable
    {
        public static readonly NoopScope Instance = new();
        public void Dispose() { }
    }

    private sealed record ActivitySnapshot(
        string Name,
        ActivityTraceId TraceId,
        ActivitySpanId SpanId,
        ActivitySpanId ParentSpanId,
        ActivityStatusCode Status,
        IReadOnlyDictionary<string, string> Tags);

    private sealed record MeasurementSnapshot(
        string Name,
        double Value,
        IReadOnlyDictionary<string, string> Tags);

    private sealed record LogSnapshot(
        LogLevel Level,
        EventId EventId,
        ActivityTraceId TraceId,
        string Message,
        IReadOnlyList<KeyValuePair<string, object?>> Properties,
        string? Exception)
    {
        public IEnumerable<string> ExportValues()
        {
            yield return Message;
            if (Exception is not null) yield return Exception;
            foreach (KeyValuePair<string, object?> property in Properties)
                yield return $"{property.Key}={property.Value}";
        }
    }
}
