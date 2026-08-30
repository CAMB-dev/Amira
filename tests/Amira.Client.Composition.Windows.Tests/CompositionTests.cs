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

    private static string CreateDirectory()
    {
        string path = Path.Combine(Path.GetTempPath(), "Amira.Tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(path);
        return path;
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
}
