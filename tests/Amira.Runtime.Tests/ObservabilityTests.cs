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

            ActivitySnapshot commit = Assert.Single(telemetry.Activities, static item => item.Name == AmiraTelemetry.MessageCommitActivity);
            Assert.Equal(ActivityStatusCode.Ok, commit.Status);
            Assert.Equal(AmiraTelemetry.Outcomes.Success, commit.Tags[AmiraTelemetry.Tags.Outcome]);
            ActivitySnapshot[] turns = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.TurnExecuteActivity)];
            ActivitySnapshot[] contexts = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ContextBuildActivity)];
            ActivitySnapshot[] requests = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.ProviderRequestActivity)];
            Assert.Equal(2, turns.Length);
            Assert.Equal(2, contexts.Length);
            Assert.Equal(2, requests.Length);
            Assert.All(turns, turn =>
            {
                Assert.Equal(expectedTraceId, turn.TraceId);
                Assert.Equal(commit.SpanId, turn.ParentSpanId);
                Assert.Equal(AmiraTelemetry.Outcomes.Success, turn.Tags[AmiraTelemetry.Tags.Outcome]);
                string turnId = turn.Tags[AmiraTelemetry.Tags.TurnId];
                ActivitySnapshot context = Assert.Single(contexts, item => item.Tags[AmiraTelemetry.Tags.TurnId] == turnId);
                ActivitySnapshot request = Assert.Single(requests, item => item.Tags[AmiraTelemetry.Tags.TurnId] == turnId);
                Assert.Equal(expectedTraceId, context.TraceId);
                Assert.Equal(turn.SpanId, context.ParentSpanId);
                Assert.Equal(expectedTraceId, request.TraceId);
                Assert.Equal(turn.SpanId, request.ParentSpanId);
            });
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
        Assert.Equal(ActivityStatusCode.Error, stopped.Status);
        Assert.Equal(AmiraTelemetry.ErrorCodes.OperationCancelled, stopped.Tags[AmiraTelemetry.Tags.ErrorCode]);

        ActivitySnapshot[] turns = [.. telemetry.Activities.Where(static item => item.Name == AmiraTelemetry.TurnExecuteActivity)];
        Assert.Equal(3, turns.Length);
        Assert.Equal(ActivityStatusCode.Ok, Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Success).Status);
        Assert.Equal("provider_bad", Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Failure).Tags[AmiraTelemetry.Tags.ErrorCode]);
        Assert.Equal(AmiraTelemetry.ErrorCodes.OperationCancelled, Assert.Single(turns, item => item.Tags[AmiraTelemetry.Tags.Outcome] == AmiraTelemetry.Outcomes.Cancelled).Tags[AmiraTelemetry.Tags.ErrorCode]);

        MeasurementSnapshot[] requestCounts = [.. telemetry.Measurements.Where(static item => item.Name == AmiraTelemetry.Metrics.ProviderRequestCount)];
        Assert.Equal(3, requestCounts.Length);
        Assert.Equal(
            [AmiraTelemetry.Outcomes.Cancelled, AmiraTelemetry.Outcomes.Failure, AmiraTelemetry.Outcomes.Success],
            requestCounts.Select(item => item.Tags[AmiraTelemetry.Tags.Outcome]).Order(StringComparer.Ordinal));
        Assert.Equal(3, telemetry.Measurements.Count(static item => item.Name == AmiraTelemetry.Metrics.ProviderRequestDuration));
        Assert.Equal(2, telemetry.Measurements.Count(static item => item.Name == AmiraTelemetry.Metrics.ProviderTimeToFirstToken));
        Assert.Equal(11d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.ProviderInputTokens).Value);
        Assert.Equal(13d, Assert.Single(telemetry.Measurements, static item => item.Name == AmiraTelemetry.Metrics.ProviderOutputTokens).Value);
        Assert.All(telemetry.Measurements, measurement =>
        {
            Assert.Equal(2, measurement.Tags.Count);
            Assert.Contains(AmiraTelemetry.Tags.ProviderProtocol, measurement.Tags.Keys);
            Assert.Contains(AmiraTelemetry.Tags.Outcome, measurement.Tags.Keys);
        });

        int[] eventIds = [.. logger.Entries.Select(static entry => entry.EventId.Id)];
        Assert.Contains((int)AmiraLogEvent.ProviderRequestStarted, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestCompleted, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestFailed, eventIds);
        Assert.Contains((int)AmiraLogEvent.ProviderRequestCancelled, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnCompleted, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnFailed, eventIds);
        Assert.Contains((int)AmiraLogEvent.TurnCancelled, eventIds);

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
            Entries.Add(new LogSnapshot(eventId, formatter(state, exception), properties, exception?.ToString()));
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
        EventId EventId,
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
