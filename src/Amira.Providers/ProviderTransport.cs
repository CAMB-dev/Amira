namespace Amira.Providers;

/// <summary>Owns the reusable HTTP transport used by model providers.</summary>
public sealed class ProviderTransport : IDisposable
{
    private readonly HttpClient client;

    private ProviderTransport(HttpMessageHandler handler, bool disposeHandler)
    {
        client = new HttpClient(handler, disposeHandler);
    }

    /// <summary>Creates a transport that never follows HTTP redirects.</summary>
    public static ProviderTransport CreateSecureDefault() =>
        new(new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false
        }, disposeHandler: true);

    /// <summary>
    /// Creates a transport around a caller-controlled handler. The caller is responsible for
    /// ensuring that the handler does not forward credentials while following redirects.
    /// </summary>
    public static ProviderTransport CreateUnsafeCustom(HttpMessageHandler handler, bool disposeHandler = true)
    {
        ArgumentNullException.ThrowIfNull(handler);
        return new ProviderTransport(handler, disposeHandler);
    }

    internal Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken) =>
        client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);

    public void Dispose() => client.Dispose();
}
