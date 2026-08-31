using System.Diagnostics;
using System.Diagnostics.Metrics;
using Amira.Client.Composition.Windows;
using Amira.Contracts;
using Amira.Credentials.Windows;
using Amira.Domain;
using Amira.Errors;
using Amira.Persistence.Sqlite;
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
    public async Task Host_creates_durable_trace_and_runtime_instruments_without_an_ambient_activity()
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

            ProviderConnection connection = await host.CreateProviderConnectionAsync(
                ProviderProtocol.OpenAIChatCompatible,
                "Loopback test connection",
                new Uri("http://127.0.0.1:1"),
                secretCanary,
                defaultModel: "test-model",
                enabled: true,
                cancellationToken: TestContext.Current.CancellationToken);
            credentialReference = connection.CredentialReference;
            Bot bot = await host.CreateBotAsync(
                new CreateBotCommand(BotProfile.Create("Trace bot"), ModelProfile.Create(connection.Id, "test-model")),
                TestContext.Current.CancellationToken);

            QueuedMessageResult queued = await host.SendAsync(bot.Id, promptCanary, TestContext.Current.CancellationToken);
            _ = await sink.Failed.Task.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
            await host.StopAsync();

            using var store = new SqliteAmiraStore(Path.Combine(directory, "amira.db"));
            await store.InitializeAsync(TestContext.Current.CancellationToken);
            BotTurn retry = await store.RetryTurnAsync(queued.Turn.Id, TestContext.Current.CancellationToken);
            ClaimedTurn durableTurn = await store.TryClaimNextTurnAsync(retry.BotId, TestContext.Current.CancellationToken)
                ?? throw new InvalidOperationException("The retried turn was not available for inspection.");
            Assert.NotEqual(default, durableTurn.ParentActivityContext.TraceId);

            string logs = string.Join(Environment.NewLine, Directory.EnumerateFiles(host.LogsDirectory, "*.jsonl")
                .SelectMany(File.ReadLines));
            Assert.DoesNotContain(promptCanary, logs, StringComparison.Ordinal);
            Assert.DoesNotContain(secretCanary, logs, StringComparison.Ordinal);

            Assert.Contains(AmiraTelemetry.Metrics.ProviderRequestDuration, publishedInstruments);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.ProviderRequestCount
                && measurement.Outcome == AmiraTelemetry.Outcomes.Failure);
            Assert.Contains(observedMeasurements, measurement =>
                measurement.Name == AmiraTelemetry.Metrics.ProviderRequestDuration
                && measurement.Outcome == AmiraTelemetry.Outcomes.Failure);
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
        public TaskCompletionSource<ChatRuntimeEvent.Failed> Failed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public ValueTask PublishAsync(ChatRuntimeEvent runtimeEvent, CancellationToken cancellationToken = default)
        {
            if (runtimeEvent is ChatRuntimeEvent.Failed failed) Failed.TrySetResult(failed);
            return ValueTask.CompletedTask;
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
        public ValueTask RequestStopAsync(BotTurnId turnId, CancellationToken cancellationToken = default) => throw new NotSupportedException();
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
