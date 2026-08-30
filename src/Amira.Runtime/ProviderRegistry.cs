using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Runtime;

/// <summary>Explicit, immutable-at-use provider selection. It deliberately performs no assembly scanning.</summary>
public sealed class ProviderRegistry
{
    private readonly Dictionary<ProviderProtocol, IModelProvider> _providers = [];
    private readonly object _gate = new();
    private bool _frozen;

    public ProviderRegistry(IEnumerable<IModelProvider>? providers = null)
    {
        if (providers is null) return;
        foreach (IModelProvider provider in providers) Register(provider);
    }

    public void Register(IModelProvider provider)
    {
        ArgumentNullException.ThrowIfNull(provider);
        lock (_gate)
        {
            if (_frozen)
                throw new AmiraException(new(AmiraErrorCodes.ProviderRegistryFrozen, ErrorCategory.Configuration, "The provider registry is frozen."));
            if (_providers.ContainsKey(provider.Protocol))
                throw new AmiraException(new(AmiraErrorCodes.ProviderDuplicate, ErrorCategory.Configuration, "A provider is already registered for this protocol."));
            _providers.Add(provider.Protocol, provider);
        }
    }

    /// <summary>Prevents any registrations after application composition has completed.</summary>
    public void Freeze()
    {
        lock (_gate) _frozen = true;
    }

    public bool TryGet(ProviderProtocol protocol, out IModelProvider? provider)
    {
        lock (_gate) return _providers.TryGetValue(protocol, out provider);
    }

    public IModelProvider Get(ProviderProtocol protocol)
    {
        lock (_gate)
        {
            if (_providers.TryGetValue(protocol, out IModelProvider? provider)) return provider;
        }

        throw new AmiraException(new(AmiraErrorCodes.ProviderUnavailable, ErrorCategory.Configuration, "No provider is registered for this protocol."));
    }
}
