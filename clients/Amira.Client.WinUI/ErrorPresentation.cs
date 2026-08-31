using Amira.Errors;

namespace Amira.Client.WinUI;

public static class ErrorPresentation
{
    public static string For(Exception exception)
    {
        ArgumentNullException.ThrowIfNull(exception);
        return exception is AmiraException amira ? $"{amira.Error.Message} ({amira.Error.Code})" : "Something unexpected went wrong. Please try again.";
    }
}
