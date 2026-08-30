using Amira.Domain;

namespace Amira.Credentials.Windows;

/// <summary>Stores and removes provider secrets in the current user's Windows credential set.</summary>
public interface IWindowsCredentialVault
{
    ValueTask StoreAsync(CredentialReference reference, string secret, CancellationToken cancellationToken = default);
    ValueTask DeleteAsync(CredentialReference reference, CancellationToken cancellationToken = default);
}
