using System.Runtime.InteropServices;

namespace Amira.Credentials.Windows;

[StructLayout(LayoutKind.Sequential)]
internal struct NativeFileTime
{
    public uint LowDateTime;
    public uint HighDateTime;
}

[StructLayout(LayoutKind.Sequential)]
internal unsafe struct NativeCredential
{
    public uint Flags;
    public uint Type;
    public char* TargetName;
    public char* Comment;
    public NativeFileTime LastWritten;
    public uint CredentialBlobSize;
    public byte* CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public void* Attributes;
    public char* TargetAlias;
    public char* UserName;
}

internal static partial class CredentialNativeMethods
{
    [LibraryImport("Advapi32.dll", EntryPoint = "CredWriteW", SetLastError = true)]
    internal static unsafe partial int CredWrite(NativeCredential* credential, uint flags);

    [LibraryImport("Advapi32.dll", EntryPoint = "CredReadW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    internal static partial int CredRead(string targetName, uint type, uint flags, out nint credential);

    [LibraryImport("Advapi32.dll", EntryPoint = "CredDeleteW", SetLastError = true, StringMarshalling = StringMarshalling.Utf16)]
    internal static partial int CredDelete(string targetName, uint type, uint flags);

    [LibraryImport("Advapi32.dll", EntryPoint = "CredFree")]
    internal static partial void CredFree(nint buffer);
}
