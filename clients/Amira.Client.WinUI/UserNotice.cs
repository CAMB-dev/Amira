namespace Amira.Client.WinUI;

public enum UserNoticeSeverity
{
    Success,
    Error,
}

public sealed record UserNotice(UserNoticeSeverity Severity, string Message)
{
    public static UserNotice Successful(string message) => new(UserNoticeSeverity.Success, message);

    public static UserNotice FromError(Exception exception) =>
        new(UserNoticeSeverity.Error, ErrorPresentation.For(exception));
}
