using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Text.Json;
using Amira.Client.Composition.Windows;
using Amira.Contracts;
using Amira.Credentials.Windows;
using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;
using Microsoft.Extensions.Logging.Abstractions;

namespace Amira.Client.Composition.Windows.Tests;

public sealed class CompositionTests
{
    [Fact]
    public async Task WorkspaceIdentity_round_trips()
    {
        string directory = CreateDirectory();
        try
        {
            var store = new WorkspaceIdentityStore(Path.Combine(directory, "workspace.id"));
            WorkspaceId first = await store.LoadOrCreateAsync(TestContext.Current.CancellationToken);
            WorkspaceId second = await store.LoadOrCreateAsync(TestContext.Current.CancellationToken);
            Assert.Equal(first, second);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Corrupt_workspace_identity_is_persistence_error()
    {
        string directory = CreateDirectory();
        try
        {
            string path = Path.Combine(directory, "workspace.id");
            await File.WriteAllTextAsync(path, " ", TestContext.Current.CancellationToken);
            AmiraException error = await Assert.ThrowsAsync<AmiraException>(async () => await new WorkspaceIdentityStore(path).LoadOrCreateAsync(TestContext.Current.CancellationToken));
            Assert.Equal(AmiraErrorCodes.WorkspaceIdentityInvalid, error.Code);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Lease_rejects_second_then_allows_after_release()
    {
        string directory = CreateDirectory();
        try
        {
            string database = Path.Combine(directory, "amira.db");
            using (SingleInstanceLease first = await SingleInstanceLease.AcquireAsync(database, TestContext.Current.CancellationToken))
            {
                AmiraException error = await Assert.ThrowsAsync<AmiraException>(async () => await SingleInstanceLease.AcquireAsync(database, TestContext.Current.CancellationToken));
                Assert.Equal(AmiraErrorCodes.ClientInstanceAlreadyRunning, error.Code);
            }
            using SingleInstanceLease second = await SingleInstanceLease.AcquireAsync(database, TestContext.Current.CancellationToken);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Failed_create_compensates_new_secret()
    {
        var vault = new FakeVault();
        var service = new ProviderConnectionService(vault, new FakeStore { SaveFailure = new AmiraException(new("save_failed", ErrorCategory.Persistence, "failed")) }, NullLogger<ProviderConnectionService>.Instance);
        await Assert.ThrowsAsync<AmiraException>(async () => await service.CreateAsync(ProviderProtocol.OpenAIChatCompatible, "OpenAI", new Uri("https://example.test"), "secret", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal(vault.Stored.Single(), vault.Deleted.Single());
    }

    [Fact]
    public async Task Failed_create_preserves_save_failure_when_compensation_fails()
    {
        var vault = new FakeVault { DeleteFailure = new InvalidOperationException() };
        var service = new ProviderConnectionService(vault, new FakeStore { SaveFailure = new AmiraException(new("save_failed", ErrorCategory.Persistence, "failed")) }, NullLogger<ProviderConnectionService>.Instance);
        AmiraException error = await Assert.ThrowsAsync<AmiraException>(async () => await service.CreateAsync(ProviderProtocol.OpenAIChatCompatible, "OpenAI", new Uri("https://example.test"), "secret", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Equal("save_failed", error.Code);
    }

    [Fact]
    public async Task Blank_replacement_keeps_existing_credential()
    {
        var vault = new FakeVault();
        var store = new FakeStore();
        var service = new ProviderConnectionService(vault, store, NullLogger<ProviderConnectionService>.Instance);
        ProviderConnection connection = ProviderConnection.Create(ProviderProtocol.OpenAIChatCompatible, "OpenAI", new Uri("https://example.test"), CredentialReference.Create("provider/old"));
        ProviderConnection updated = await service.UpdateAsync(connection, "Changed", new Uri("https://example.test"), "  ", null, new Dictionary<string, string>(), true, TestContext.Current.CancellationToken);
        Assert.Equal(connection.CredentialReference, updated.CredentialReference);
        Assert.Empty(vault.Stored);
        Assert.Empty(vault.Deleted);
    }

    [Fact]
    public async Task Invalid_provider_configuration_does_not_store_a_secret()
    {
        var vault = new FakeVault();
        var service = new ProviderConnectionService(vault, new FakeStore(), NullLogger<ProviderConnectionService>.Instance);
        await Assert.ThrowsAsync<AmiraException>(async () => await service.CreateAsync(ProviderProtocol.OpenAIChatCompatible, "OpenAI", new Uri("http://example.test"), "secret", cancellationToken: TestContext.Current.CancellationToken));
        Assert.Empty(vault.Stored);
    }

    [Fact]
    public async Task Replacement_saves_new_secret_then_removes_old_secret()
    {
        var vault = new FakeVault();
        var store = new FakeStore();
        var service = new ProviderConnectionService(vault, store, NullLogger<ProviderConnectionService>.Instance);
        ProviderConnection connection = ProviderConnection.Create(ProviderProtocol.OpenAIChatCompatible, "OpenAI", new Uri("https://example.test"), CredentialReference.Create("provider/old"));
        ProviderConnection updated = await service.UpdateAsync(connection, "OpenAI", new Uri("https://example.test"), "new-secret", null, new Dictionary<string, string>(), true, TestContext.Current.CancellationToken);
        Assert.Equal(updated.CredentialReference, vault.Stored.Single());
        Assert.Equal(connection.CredentialReference, vault.Deleted.Single());
    }

    [Fact]
    public void Blank_client_path_is_a_product_error()
    {
        AmiraException error = Assert.Throws<AmiraException>(() => ClientPaths.Create(" "));
        Assert.Equal(AmiraErrorCodes.ClientPathInvalid, error.Code);
    }

    [Fact]
    public async Task Host_reuses_workspace_and_rejects_second_instance()
    {
        string directory = CreateDirectory();
        try
        {
            await using WindowsClientHost first = await WindowsClientHost.StartAsync(new NullSink(), directory, TestContext.Current.CancellationToken);
            WorkspaceId id = first.WorkspaceId;
            AmiraException error = await Assert.ThrowsAsync<AmiraException>(async () => await WindowsClientHost.StartAsync(new NullSink(), directory, TestContext.Current.CancellationToken));
            Assert.Equal(AmiraErrorCodes.ClientInstanceAlreadyRunning, error.Code);
            await first.StopAsync();
            await using WindowsClientHost second = await WindowsClientHost.StartAsync(new NullSink(), directory, TestContext.Current.CancellationToken);
            Assert.Equal(id, second.WorkspaceId);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Fact]
    public async Task Host_jsonl_correlates_pre_provider_and_provider_failures_without_an_ambient_activity()
    {
        const string promptCanary = "HOST_PROMPT_CANARY_47C8";
        const string secretCanary = "HOST_SECRET_CANARY_71A9";
        string directory = CreateDirectory();
        var sink = new TerminalEventSink();
        var publishedInstruments = new List<string>();
        var observedMeasurements = new List<(string Name, string? Outcome)>();
        using var meterListener = new MeterListener
        {
            InstrumentPublished = (instrument, listener) =>
            {
                if (instrument.Meter.Name != AmiraTelemetry.MeterName) return;
                publishedInstruments.Add(instrument.Name);
                listener.EnableMeasurementEvents(instrument);
            }
        };
        meterListener.SetMeasurementEventCallback<long>((instrument, _, tags, _) =>
            observedMeasurements.Add((instrument.Name, FindTag(tags, AmiraTelemetry.Tags.Outcome))));
        meterListener.SetMeasurementEventCallback<double>((instrument, _, tags, _) =>
            observedMeasurements.Add((instrument.Name, FindTag(tags, AmiraTelemetry.Tags.Outcome))));
        meterListener.Start();

        Activity? previous = Activity.Current;
        CredentialReference? credentialReference = null;
        try
        {
            Activity.Current = null;
            await using WindowsClientHost host = await WindowsClientHost.StartAsync(sink, directory, TestContext.Current.CancellationToken);
            Assert.Equal(Path.Combine(directory, "logs"), host.LogsDirectory);
            Assert.Contains(AmiraTelemetry.Metrics.ProviderRequestCount, publishedInstruments);
            Assert.Contains(AmiraTelemetry.Metrics.TurnQueuedTotal, publishedInstruments);
            Assert.Contains(AmiraTelemetry.Metrics.QueuedTurns, publishedInstruments);
            Assert.Contains(AmiraTelemetry.Metrics.ActiveTurns, publishedInstruments);
            Assert.Contains(AmiraTelemetry.Metrics.TurnStopRequestedTotal, publishedInstruments);
            Assert.Contains(AmiraTelemetry.Metrics.TurnCancelledTotal, publishedInstruments);

            ProviderConnection connection = await host.CreateProviderConnectionAsync(
                ProviderProtocol.OpenAIChatCompatible,
                "Loopback test connection",
                new Uri("http://127.0.0.1:1"),
                secretCanary,
                defaultModel: "test-model",
                enabled: false,
                cancellationToken: TestContext.Current.CancellationToken);
            credentialReference = connection.CredentialReference;
            Bot bot = await host.CreateBotAsync(
                new CreateBotCommand(BotProfile.Create("Trace bot"), ModelProfile.Create(connection.Id, "test-model")),
                TestContext.Current.CancellationToken);

            QueuedMessageResult disabledQueued = await host.SendAsync(bot.Id, promptCanary, TestContext.Current.CancellationToken);
            ChatRuntimeEvent.Failed disabledFailure = await sink.NextFailureAsync(TestContext.Current.CancellationToken);
            Assert.Equal(disabledQueued.Turn.Id, disabledFailure.TurnId);
            Assert.Equal(AmiraErrorCodes.ConnectionDisabled, disabledFailure.Failure.Code);

            connection = await host.UpdateProviderConnectionAsync(
                connection,
                connection.DisplayName,
                connection.BaseUrl,
                replacementSecret: null,
                connection.DefaultModel,
                connection.ExtraHeaders,
                enabled: true,
                cancellationToken: TestContext.Current.CancellationToken);
            QueuedMessageResult providerQueued = await host.SendAsync(bot.Id, promptCanary, TestContext.Current.CancellationToken);
            ChatRuntimeEvent.Failed providerFailure = await sink.NextFailureAsync(TestContext.Current.CancellationToken);
            Assert.Equal(providerQueued.Turn.Id, providerFailure.TurnId);
            Assert.Equal(ErrorCategory.Provider, providerFailure.Failure.Category);
            await host.StopAsync();

            string logs = string.Join(Environment.NewLine, Directory.EnumerateFiles(host.LogsDirectory, "*.jsonl")
                .SelectMany(File.ReadLines));
            Assert.DoesNotContain(promptCanary, logs, StringComparison.Ordinal);
            Assert.DoesNotContain(secretCanary, logs, StringComparison.Ordinal);

            JsonElement[] entries = ParseJsonLines(logs);
            JsonElement[] disabledLogs = LogsForTurn(entries, disabledQueued.Turn.Id);
            JsonElement[] providerLogs = LogsForTurn(entries, providerQueued.Turn.Id);
            Assert.NotEmpty(disabledLogs);
            Assert.NotEmpty(providerLogs);
            Assert.All(disabledLogs, entry => AssertRuntimeLogIdentity(entry, bot, disabledQueued.Turn));
            Assert.All(providerLogs, entry => AssertRuntimeLogIdentity(entry, bot, providerQueued.Turn));

            string disabledTraceId = Assert.Single(disabledLogs.Select(GetTraceId).Distinct(StringComparer.Ordinal));
            string providerTraceId = Assert.Single(providerLogs.Select(GetTraceId).Distinct(StringComparer.Ordinal));
            Assert.NotEqual(disabledTraceId, providerTraceId);

            JsonElement disabledTerminal = Assert.Single(
                disabledLogs,
                static entry => entry.GetProperty("event_id").GetInt32() == (int)AmiraLogEvent.TurnFailed);
            Assert.Equal(AmiraErrorCodes.ConnectionDisabled, disabledTerminal.GetProperty("ErrorCode").GetString());
            Assert.Equal(ErrorCategory.Configuration.ToString(), disabledTerminal.GetProperty("ErrorCategory").GetString());
            Assert.Equal("Warning", disabledTerminal.GetProperty("level").GetString());

            JsonElement providerTerminal = Assert.Single(
                providerLogs,
                static entry => entry.GetProperty("event_id").GetInt32() == (int)AmiraLogEvent.ProviderRequestFailed);
            Assert.Equal(providerFailure.Failure.Code, providerTerminal.GetProperty("ErrorCode").GetString());
            Assert.Equal(providerFailure.Failure.Category.ToString(), providerTerminal.GetProperty("ErrorCategory").GetString());
            Assert.Equal(JsonValueKind.Number, providerTerminal.GetProperty("DurationMs").ValueKind);
            Assert.Equal(JsonValueKind.Null, providerTerminal.GetProperty("UsageInput").ValueKind);
            Assert.Equal(JsonValueKind.Null, providerTerminal.GetProperty("UsageOutput").ValueKind);
            Assert.Equal("Warning", providerTerminal.GetProperty("level").GetString());

            Assert.Contains(AmiraTelemetry.Metrics.ProviderRequestDuration, publishedInstruments);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.ProviderRequestCount
                && measurement.Outcome == AmiraTelemetry.Outcomes.Failure);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.ProviderRequestDuration
                && measurement.Outcome == AmiraTelemetry.Outcomes.Failure);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.TurnQueuedTotal
                && measurement.Outcome is null);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.ActiveTurns
                && measurement.Outcome is null);
        }
        finally
        {
            Activity.Current = previous;
            if (credentialReference is { } reference)
                await new WindowsCredentialVault().DeleteAsync(reference, TestContext.Current.CancellationToken);
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public async Task Worker_registry_unregisters_on_archive_path_and_can_register_again_on_restore_path()
    {
        var store = new IdleStore();
        var runtime = new BasicChatRuntime(store, store, new ProviderRegistry());
        var registry = new BotWorkerRegistry(
            runtime,
            WorkspaceId.New(),
            new NullSink(),
            NullLogger<BotWorkerRegistry>.Instance);
        BotId botId = BotId.New();

        Assert.True(registry.EnsureRegistered(botId));
        Assert.False(registry.EnsureRegistered(botId));
        Assert.True(await registry.UnregisterAsync(botId));
        Assert.False(await registry.UnregisterAsync(botId));
        Assert.True(registry.EnsureRegistered(botId));

        await registry.DisposeAsync();
    }

    private static string CreateDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "Amira.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
    }

    private static string? FindTag(ReadOnlySpan<KeyValuePair<string, object?>> tags, string name)
    {
        foreach (KeyValuePair<string, object?> tag in tags)
        {
            if (tag.Key == name) return tag.Value?.ToString();
        }

        return null;
    }

    private static JsonElement[] ParseJsonLines(string payload)
    {
        var entries = new List<JsonElement>();
        foreach (string line in payload.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries))
        {
            using JsonDocument document = JsonDocument.Parse(line);
            entries.Add(document.RootElement.Clone());
        }

        return [.. entries];
    }

    private static JsonElement[] LogsForTurn(IEnumerable<JsonElement> entries, BotTurnId turnId) =>
        [.. entries.Where(entry =>
            entry.TryGetProperty("TurnId", out JsonElement value)
            && value.GetString() == turnId.Value)];

    private static string GetTraceId(JsonElement entry)
    {
        string? traceId = entry.GetProperty("@tr").GetString();
        Assert.False(string.IsNullOrWhiteSpace(traceId));
        return traceId;
    }

    private static void AssertRuntimeLogIdentity(JsonElement entry, Bot bot, BotTurn turn)
    {
        Assert.Equal(bot.Id.Value, entry.GetProperty("BotId").GetString());
        Assert.Equal(bot.DirectChatId.Value, entry.GetProperty("ChatId").GetString());
        Assert.Equal(turn.Id.Value, entry.GetProperty("TurnId").GetString());
        Assert.Equal(turn.ModelProfileSnapshot.Protocol.ToString(), entry.GetProperty("ProviderProtocol").GetString());
        Assert.Equal(turn.ModelProfileSnapshot.Model, entry.GetProperty("Model").GetString());
        _ = GetTraceId(entry);
    }

    private sealed class FakeVault : IWindowsCredentialVault
    {
        public Exception? DeleteFailure { get; init; }
        public List<CredentialReference> Stored { get; } = [];
        public List<CredentialReference> Deleted { get; } = [];
        public ValueTask StoreAsync(CredentialReference reference, string secret, CancellationToken cancellationToken = default) { Stored.Add(reference); return ValueTask.CompletedTask; }
        public ValueTask DeleteAsync(CredentialReference reference, CancellationToken cancellationToken = default)
        {
            Deleted.Add(reference);
            return DeleteFailure is null ? ValueTask.CompletedTask : ValueTask.FromException(DeleteFailure);
        }
    }

    private sealed class FakeStore : IWorkspaceStore
    {
        public Exception? SaveFailure { get; init; }
        public ValueTask SaveProviderConnectionAsync(ProviderConnection connection, CancellationToken cancellationToken = default) => SaveFailure is null ? ValueTask.CompletedTask : ValueTask.FromException(SaveFailure);
        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot?> GetBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<ProviderConnection?> GetProviderConnectionAsync(ProviderConnectionId connectionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<ProviderConnection>> ListProviderConnectionsAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class NullSink : IChatRuntimeEventSink
    {
        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default) => ValueTask.CompletedTask;
    }

    private sealed class TerminalEventSink : IChatRuntimeEventSink
    {
        private readonly System.Collections.Concurrent.ConcurrentQueue<ChatRuntimeEvent.Failed> _failures = new();
        private readonly SemaphoreSlim _available = new(0);

        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
        {
            if (runtimeEvent is ChatRuntimeEvent.Failed failed)
            {
                _failures.Enqueue(failed);
                _available.Release();
            }
            return ValueTask.CompletedTask;
        }

        public async ValueTask<ChatRuntimeEvent.Failed> NextFailureAsync(CancellationToken cancellationToken)
        {
            if (!await _available.WaitAsync(TimeSpan.FromSeconds(5), cancellationToken).ConfigureAwait(false))
                throw new TimeoutException("The runtime did not publish a failure within the test timeout.");
            return _failures.TryDequeue(out ChatRuntimeEvent.Failed? failure)
                ? failure
                : throw new InvalidOperationException("A signalled runtime failure was not queued.");
        }
    }

    private sealed class IdleStore : IChatStore, IWorkspaceStore
    {
        public ValueTask<ClaimedTurn?> TryClaimNextTurnAsync(BotId botId, CancellationToken cancellationToken = default) =>
            ValueTask.FromResult<ClaimedTurn?>(null);

        public ValueTask<QueuedMessageResult> CommitHumanMessageAndQueueTurnAsync(HumanMessageCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask RecordFirstTokenAsync(BotTurnId turnId, TurnClaimToken claimToken, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask CompleteTurnAsync(CompleteTurnCommand command, TurnClaimToken claimToken, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask FailTurnAsync(BotTurnId turnId, TurnClaimToken claimToken, AmiraError failure, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask CancelClaimedTurnAsync(BotTurnId turnId, TurnClaimToken claimToken, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<DurableStopRequestResult> RequestStopAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask RecoverInterruptedTurnsAsync(CancellationToken cancellationToken = default) => ValueTask.CompletedTask;
        public ValueTask<BotTurn> RetryTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<ChatMessage>> LoadTimelineAsync(DirectChatId chatId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnPage> QueryTurnsAsync(TurnQuery query, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<TurnView?> GetTurnAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> CreateBotAsync(CreateBotCommand command, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot?> GetBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<Bot>> ListBotsAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> UpdateBotAsync(Bot bot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> ArchiveBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<Bot> RestoreBotAsync(BotId botId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask SaveProviderConnectionAsync(ProviderConnection connection, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<ProviderConnection?> GetProviderConnectionAsync(ProviderConnectionId connectionId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public ValueTask<IReadOnlyList<ProviderConnection>> ListProviderConnectionsAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
