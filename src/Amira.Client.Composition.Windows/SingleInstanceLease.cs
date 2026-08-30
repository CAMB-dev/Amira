using System.Security.Cryptography;
using System.Text;
using Amira.Errors;

namespace Amira.Client.Composition.Windows;

/// <summary>Exclusive database lease whose Windows mutex ownership stays on a dedicated OS thread.</summary>
public sealed class SingleInstanceLease : IDisposable
{
    private readonly Thread _ownerThread;
    private readonly ManualResetEventSlim _releaseRequested = new(false);
    private readonly TaskCompletionSource _acquired = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _disposed;

    private SingleInstanceLease(string mutexName)
    {
        _ownerThread = new Thread(() => OwnMutex(mutexName)) { IsBackground = true, Name = "Amira database lease" };
        _ownerThread.Start();
    }

    public static async ValueTask<SingleInstanceLease> AcquireAsync(string databasePath, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(databasePath))
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The database path is invalid."));
        string normalized;
        try { normalized = Path.GetFullPath(databasePath); }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException)
        {
            throw new AmiraException(new(AmiraErrorCodes.ClientPathInvalid, ErrorCategory.Configuration, "The database path is invalid."));
        }

        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(normalized.ToUpperInvariant()));
        var lease = new SingleInstanceLease($"Local\\Amira-{Convert.ToHexString(hash)}");
        try
        {
            await lease._acquired.Task.WaitAsync(cancellationToken).ConfigureAwait(false);
            return lease;
        }
        catch
        {
            lease.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _releaseRequested.Set();
        _ownerThread.Join();
        _releaseRequested.Dispose();
    }

    private void OwnMutex(string mutexName)
    {
        Mutex? mutex = null;
        bool owns = false;
        try
        {
            mutex = new Mutex(false, mutexName);
            try { owns = mutex.WaitOne(0); }
            catch (AbandonedMutexException) { owns = true; }
        }
        catch (Exception)
        {
            _acquired.TrySetException(new AmiraException(new(AmiraErrorCodes.ClientInstanceFailed, ErrorCategory.Infrastructure, "The client instance lease could not be acquired.", true)));
            mutex?.Dispose();
            return;
        }

        if (!owns)
        {
            mutex.Dispose();
            _acquired.TrySetException(new AmiraException(new(AmiraErrorCodes.ClientInstanceAlreadyRunning, ErrorCategory.Concurrency, "Another Amira client is already using this database.")));
            return;
        }

        _acquired.TrySetResult();
        _releaseRequested.Wait();
        mutex.ReleaseMutex();
        mutex.Dispose();
    }
}
