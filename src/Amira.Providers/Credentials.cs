using Amira.Domain;

namespace Amira.Providers;

/// <summary>Resolves an opaque Core credential reference at invocation time.</summary>
public interface ICredentialResolver
{
    ValueTask<string?> ResolveAsync(CredentialReference reference, CancellationToken cancellationToken = default);
}
