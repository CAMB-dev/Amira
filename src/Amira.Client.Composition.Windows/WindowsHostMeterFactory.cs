using System.Diagnostics.Metrics;

namespace Amira.Client.Composition.Windows;

/// <summary>Owns the runtime meters created by one Windows client host.</summary>
internal sealed class WindowsHostMeterFactory : IMeterFactory
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
