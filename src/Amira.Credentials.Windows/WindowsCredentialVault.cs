using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Amira.Domain;
using Amira.Errors;
using Amira.Providers;

namespace Amira.Credentials.Windows;

/// <summary>Resolves and manages opaque provider credential references through Windows Credential Manager.</summary>
public sealed class WindowsCredentialVault : IWindowsCredentialVault, ICredentialResolver
{
    private const uint CredentialTypeGeneric = 1;
    private const uint CredentialPersistLocalMachine = 2;
    private const int ErrorNotFound = 1168;
    private const int MaxCredentialBlobSize = 5 * 512;
    private const string TargetPrefix = "Amira:";
    private static readonly UTF8Encoding SecretEncoding = new(false, true);

    public unsafe ValueTask StoreAsync(
        CredentialReference reference,
        string secret,
        CancellationToken cancellationToken = default)
    {
        string targetName = GetTargetName(reference);
        if (string.IsNullOrWhiteSpace(secret))
            throw InvalidConfiguration("A non-empty credential secret is required.");

        cancellationToken.ThrowIfCancellationRequested();

        byte[] secretBytes;
        try
        {
            secretBytes = SecretEncoding.GetBytes(secret);
        }
        catch (EncoderFallbackException)
        {
            throw InvalidConfiguration("The credential secret contains invalid text.");
        }

        try
        {
            if (secretBytes.Length > MaxCredentialBlobSize)
                throw InvalidConfiguration($"The credential secret exceeds the {MaxCredentialBlobSize}-byte Windows limit.");

            fixed (char* targetNamePointer = targetName)
            fixed (byte* secretPointer = secretBytes)
            {
                var credential = new NativeCredential
                {
                    Type = CredentialTypeGeneric,
                    TargetName = targetNamePointer,
                    CredentialBlobSize = (uint)secretBytes.Length,
                    CredentialBlob = secretPointer,
                    Persist = CredentialPersistLocalMachine
                };

                if (CredentialNativeMethods.CredWrite(&credential, 0) == 0)
                    throw NativeFailure(Marshal.GetLastPInvokeError());
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(secretBytes);
        }

        return ValueTask.CompletedTask;
    }

    public unsafe ValueTask<string?> ResolveAsync(
        CredentialReference reference,
        CancellationToken cancellationToken = default)
    {
        string targetName = GetTargetName(reference);
        cancellationToken.ThrowIfCancellationRequested();

        if (CredentialNativeMethods.CredRead(targetName, CredentialTypeGeneric, 0, out nint buffer) == 0)
        {
            int errorCode = Marshal.GetLastPInvokeError();
            return errorCode == ErrorNotFound
                ? new ValueTask<string?>((string?)null)
                : ValueTask.FromException<string?>(NativeFailure(errorCode));
        }

        try
        {
            NativeCredential* credential = (NativeCredential*)buffer;
            var secretBytes = new ReadOnlySpan<byte>(credential->CredentialBlob, (int)credential->CredentialBlobSize);
            try
            {
                return new ValueTask<string?>(SecretEncoding.GetString(secretBytes));
            }
            catch (DecoderFallbackException)
            {
                return ValueTask.FromException<string?>(NativeFailure());
            }
        }
        finally
        {
            CredentialNativeMethods.CredFree(buffer);
        }
    }

    public ValueTask DeleteAsync(
        CredentialReference reference,
        CancellationToken cancellationToken = default)
    {
        string targetName = GetTargetName(reference);
        cancellationToken.ThrowIfCancellationRequested();

        if (CredentialNativeMethods.CredDelete(targetName, CredentialTypeGeneric, 0) != 0)
            return ValueTask.CompletedTask;

        int errorCode = Marshal.GetLastPInvokeError();
        return errorCode == ErrorNotFound
            ? ValueTask.CompletedTask
            : ValueTask.FromException(NativeFailure(errorCode));
    }

    private static string GetTargetName(CredentialReference reference)
    {
        if (reference.IsEmpty)
            throw InvalidConfiguration("A credential reference is required.");
        return string.Concat(TargetPrefix, reference.Value);
    }

    private static AmiraException InvalidConfiguration(string message) =>
        new(new AmiraError(AmiraErrorCodes.CredentialVaultInvalidConfiguration, ErrorCategory.Configuration, message));

    private static AmiraException NativeFailure(int? errorCode = null) =>
        new(new AmiraError(
            AmiraErrorCodes.CredentialVaultFailed,
            ErrorCategory.Infrastructure,
            errorCode is null
                ? "Windows Credential Manager returned invalid credential data."
                : $"Windows Credential Manager failed with Win32 error {errorCode.Value}."));
}
