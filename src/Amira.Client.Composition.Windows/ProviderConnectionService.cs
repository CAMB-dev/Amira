using Amira.Contracts;
using Amira.Credentials.Windows;
using Amira.Domain;
using Microsoft.Extensions.Logging;

namespace Amira.Client.Composition.Windows;

public sealed class ProviderConnectionService
{
    private readonly IWindowsCredentialVault vault;
    private readonly IWorkspaceStore store;
    private readonly ILogger<ProviderConnectionService> logger;

    public ProviderConnectionService(IWindowsCredentialVault vault, IWorkspaceStore store, ILogger<ProviderConnectionService> logger)
    {
        ArgumentNullException.ThrowIfNull(vault);
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(logger);
        this.vault = vault;
        this.store = store;
        this.logger = logger;
    }
    public async ValueTask<ProviderConnection> CreateAsync(
        ProviderProtocol protocol, string displayName, Uri baseUrl, string secret, string? defaultModel = null,
        IReadOnlyDictionary<string, string>? extraHeaders = null, bool enabled = true, CancellationToken cancellationToken = default)
    {
        CredentialReference reference = NewReference();
        ProviderConnection connection = ProviderConnection.Create(protocol, displayName, baseUrl, reference, defaultModel, extraHeaders, enabled);
        await vault.StoreAsync(reference, secret, cancellationToken).ConfigureAwait(false);
        try
        {
            await store.SaveProviderConnectionAsync(connection, cancellationToken).ConfigureAwait(false);
            return connection;
        }
        catch
        {
            await DeleteAfterFailedSaveAsync(reference).ConfigureAwait(false);
            throw;
        }
    }

    public async ValueTask<ProviderConnection> UpdateAsync(
        ProviderConnection current, string displayName, Uri baseUrl, string? replacementSecret, string? defaultModel,
        IReadOnlyDictionary<string, string> extraHeaders, bool enabled, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(current);
        ArgumentNullException.ThrowIfNull(extraHeaders);
        if (string.IsNullOrWhiteSpace(replacementSecret))
        {
            ProviderConnection unchangedSecret = current.WithSettings(displayName, baseUrl, current.CredentialReference, defaultModel, extraHeaders, enabled);
            await store.SaveProviderConnectionAsync(unchangedSecret, cancellationToken).ConfigureAwait(false);
            return unchangedSecret;
        }

        CredentialReference next = NewReference();
        ProviderConnection updated = current.WithSettings(displayName, baseUrl, next, defaultModel, extraHeaders, enabled);
        await vault.StoreAsync(next, replacementSecret, cancellationToken).ConfigureAwait(false);
        try { await store.SaveProviderConnectionAsync(updated, cancellationToken).ConfigureAwait(false); }
        catch
        {
            await DeleteAfterFailedSaveAsync(next).ConfigureAwait(false);
            throw;
        }

        try { await vault.DeleteAsync(current.CredentialReference, CancellationToken.None).ConfigureAwait(false); }
        catch (Exception exception) { logger.LogWarning(exception, "Credential cleanup failed after provider connection update: {Code} {CredentialReference}", Amira.Errors.AmiraErrorCodes.CredentialVaultFailed, current.CredentialReference.Value); }
        return updated;
    }

    private static CredentialReference NewReference() => CredentialReference.Create($"provider/{Guid.NewGuid():N}");

    private async ValueTask DeleteAfterFailedSaveAsync(CredentialReference reference)
    {
        try { await vault.DeleteAsync(reference, CancellationToken.None).ConfigureAwait(false); }
        catch (Exception exception) { logger.LogWarning(exception, "Credential compensation failed: {Code} {CredentialReference}", Amira.Errors.AmiraErrorCodes.CredentialVaultFailed, reference.Value); }
    }
}
