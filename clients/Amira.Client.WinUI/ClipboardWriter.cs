using Amira.Errors;
using Windows.ApplicationModel.DataTransfer;

namespace Amira.Client.WinUI;

public interface ITextClipboard
{
    void SetText(string text);
}

public sealed class WindowsTextClipboard : ITextClipboard
{
    public void SetText(string text)
    {
        DataPackage package = new();
        package.SetText(text);
        Clipboard.SetContent(package);
        Clipboard.Flush();
    }
}

public static class ClipboardWritePolicy
{
    public static void Write(ITextClipboard clipboard, string text)
    {
        ArgumentNullException.ThrowIfNull(clipboard);
        try { clipboard.SetText(text); }
        catch (Exception)
        {
            throw new AmiraException(new(
                AmiraErrorCodes.ClipboardWriteFailed,
                ErrorCategory.Infrastructure,
                "The text could not be copied to the clipboard.",
                true));
        }
    }
}
