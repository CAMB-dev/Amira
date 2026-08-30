using System.Net;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using Amira.Contracts;
using Amira.Domain;
using Amira.Errors;

namespace Amira.Providers;

internal static class ProviderHttp
{
    private const int ErrorBodyLimit = 16 * 1024;
    private static readonly HashSet<string> ProtectedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "authorization", "x-api-key", "anthropic-version", "content-type", "accept", "host"
    };

    public static Uri Endpoint(ProviderConnection connection, string relativePath)
    {
        ArgumentNullException.ThrowIfNull(connection);
        var baseUrl = connection.BaseUrl;
        if (!baseUrl.IsAbsoluteUri || string.IsNullOrEmpty(baseUrl.Host) ||
            (!string.Equals(baseUrl.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) &&
             !(string.Equals(baseUrl.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) && baseUrl.IsLoopback)) ||
            !string.IsNullOrEmpty(baseUrl.UserInfo) || !string.IsNullOrEmpty(baseUrl.Query) || !string.IsNullOrEmpty(baseUrl.Fragment))
        {
            throw ConfigurationFailure(AmiraErrorCodes.InvalidBaseUrl, "The provider base URL is invalid.");
        }

        var root = baseUrl.AbsoluteUri.TrimEnd('/');
        return new Uri($"{root}/{relativePath.TrimStart('/')}", UriKind.Absolute);
    }

    public static async ValueTask<string> ResolveCredentialAsync(
        ICredentialResolver resolver,
        ProviderConnection connection,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(resolver);
        string? credential = await resolver.ResolveAsync(connection.CredentialReference, cancellationToken).ConfigureAwait(false);
        if (string.IsNullOrWhiteSpace(credential))
            throw ConfigurationFailure(AmiraErrorCodes.CredentialMissing, "The provider credential could not be resolved.");
        return credential;
    }

    public static HttpRequestMessage CreateRequest(
        HttpMethod method,
        Uri endpoint,
        byte[] body,
        ProviderConnection connection,
        string credential,
        bool anthropic)
    {
        var request = new HttpRequestMessage(method, endpoint)
        {
            Content = new ByteArrayContent(body)
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        if (anthropic)
        {
            request.Headers.TryAddWithoutValidation("x-api-key", credential);
            request.Headers.TryAddWithoutValidation("anthropic-version", "2023-06-01");
        }
        else
        {
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        }

        foreach (var header in connection.ExtraHeaders)
        {
            if (ProtectedHeaders.Contains(header.Key))
                throw ConfigurationFailure(AmiraErrorCodes.InvalidHeader, "Provider configuration contains a protected header.");
            if (!request.Headers.TryAddWithoutValidation(header.Key, header.Value) &&
                !request.Content.Headers.TryAddWithoutValidation(header.Key, header.Value))
                throw ConfigurationFailure(AmiraErrorCodes.InvalidHeader, "Provider configuration contains an invalid header.");
        }

        return request;
    }

    public static async ValueTask<HttpResponseMessage> SendAsync(
        ProviderTransport transport,
        HttpRequestMessage request,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await transport.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (response.IsSuccessStatusCode)
                return response;

            if ((int)response.StatusCode is >= 300 and < 400)
            {
                response.Dispose();
                throw Failure(AmiraErrorCodes.ProviderRedirect, "The provider returned a redirect, which is not allowed.");
            }

            string body = await ReadLimitedUtf8Async(response.Content, ErrorBodyLimit, cancellationToken).ConfigureAwait(false);
            var statusCode = response.StatusCode;
            response.Dispose();
            throw CreateHttpException(statusCode, body);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw Failure(AmiraErrorCodes.ProviderTimeout, "The provider request timed out.", true);
        }
        catch (HttpRequestException)
        {
            throw Failure(AmiraErrorCodes.NetworkError, "The provider request could not be completed.", true);
        }
    }

    public static AmiraException CreateHttpException(HttpStatusCode statusCode, string body)
    {
        string? providerCode = null;
        try
        {
            var error = JsonSerializer.Deserialize(body, ProviderJsonContext.Default.ProviderErrorDto);
            providerCode = error?.Error?.Code ?? error?.Error?.Type;
        }
        catch (JsonException)
        {
            // The response body is intentionally not surfaced.
        }

        string code = statusCode switch
        {
            HttpStatusCode.Unauthorized => AmiraErrorCodes.AuthenticationError,
            HttpStatusCode.Forbidden => AmiraErrorCodes.PermissionError,
            HttpStatusCode.BadRequest or HttpStatusCode.UnprocessableEntity => AmiraErrorCodes.InvalidRequest,
            HttpStatusCode.RequestTimeout => AmiraErrorCodes.ProviderTimeout,
            (HttpStatusCode)429 => AmiraErrorCodes.RateLimit,
            _ when (int)statusCode >= 500 => AmiraErrorCodes.ProviderServerError,
            _ => AmiraErrorCodes.ProviderHttpError
        };
        if (!string.IsNullOrWhiteSpace(providerCode)) code = MapErrorCode(providerCode, code);
        var transient = statusCode == HttpStatusCode.RequestTimeout || statusCode == (HttpStatusCode)429 || (int)statusCode >= 500;
        return Failure(code, $"The provider returned HTTP status {(int)statusCode}.", transient);
    }

    public static AmiraException Failure(string code, string message, bool isTransient = false) =>
        new(new AmiraError(code, ErrorCategory.Provider, message, isTransient));

    private static AmiraException ConfigurationFailure(string code, string message) =>
        new(new AmiraError(code, ErrorCategory.Configuration, message));

    public static bool IsTransientCode(string? code) => code is not null &&
        (code.Contains("rate", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("limit", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("overload", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("timeout", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("tempor", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("unavailable", StringComparison.OrdinalIgnoreCase) ||
         code.Contains("server", StringComparison.OrdinalIgnoreCase));

    public static string MapErrorCode(string? upstreamCode, string unknownCode)
    {
        if (string.IsNullOrWhiteSpace(upstreamCode)) return KnownFallback(unknownCode);
        var normalized = upstreamCode.Replace("-", string.Empty, StringComparison.Ordinal)
            .Replace("_", string.Empty, StringComparison.Ordinal)
            .Replace(".", string.Empty, StringComparison.Ordinal)
            .Replace(" ", string.Empty, StringComparison.Ordinal)
            .ToLowerInvariant();
        if (normalized.Contains("invalidapikey", StringComparison.Ordinal) || normalized.Contains("authentication", StringComparison.Ordinal) || normalized == "unauthorized" || normalized == "autherror") return AmiraErrorCodes.AuthenticationError;
        if (normalized.Contains("permission", StringComparison.Ordinal) || normalized == "forbidden" || normalized == "accessdenied") return AmiraErrorCodes.PermissionError;
        if (normalized.Contains("invalidrequest", StringComparison.Ordinal) || normalized.Contains("invalidparameter", StringComparison.Ordinal) || normalized == "badrequest") return AmiraErrorCodes.InvalidRequest;
        if (normalized.Contains("notfound", StringComparison.Ordinal) || normalized.Contains("modelnotfound", StringComparison.Ordinal)) return AmiraErrorCodes.NotFound;
        if (normalized.Contains("ratelimit", StringComparison.Ordinal) || normalized.Contains("toomanyrequests", StringComparison.Ordinal) || normalized == "limit") return AmiraErrorCodes.RateLimit;
        if (normalized.Contains("timeout", StringComparison.Ordinal) || normalized.Contains("timedout", StringComparison.Ordinal)) return AmiraErrorCodes.ProviderTimeout;
        if (normalized.Contains("overload", StringComparison.Ordinal)) return AmiraErrorCodes.ProviderOverloaded;
        if (normalized.Contains("servererror", StringComparison.Ordinal) || normalized.Contains("internalserver", StringComparison.Ordinal)) return AmiraErrorCodes.ProviderServerError;
        if (normalized == "streamprotocol") return AmiraErrorCodes.StreamProtocol;
        return KnownFallback(unknownCode);
    }

    private static string KnownFallback(string code) => code switch
        {
            AmiraErrorCodes.AuthenticationError or AmiraErrorCodes.PermissionError or AmiraErrorCodes.InvalidRequest or
            AmiraErrorCodes.NotFound or AmiraErrorCodes.RateLimit or AmiraErrorCodes.ProviderTimeout or
            AmiraErrorCodes.ProviderOverloaded or AmiraErrorCodes.ProviderServerError or AmiraErrorCodes.StreamProtocol or
            AmiraErrorCodes.ProviderStreamError or AmiraErrorCodes.ProviderHttpError => code,
            _ => AmiraErrorCodes.ProviderHttpError
        };

    public static async ValueTask<string> ReadLimitedUtf8Async(HttpContent content, int limit, CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var buffer = new byte[4096];
        using var output = new MemoryStream();
        while (output.Length < limit)
        {
            int requested = (int)Math.Min(buffer.Length, limit - output.Length);
            int read = await stream.ReadAsync(buffer.AsMemory(0, requested), cancellationToken).ConfigureAwait(false);
            if (read == 0) break;
            output.Write(buffer, 0, read);
        }
        return Encoding.UTF8.GetString(output.ToArray());
    }

    public static async ValueTask<bool> MoveNextSseAsync(IAsyncEnumerator<SseEvent> enumerator)
    {
        try
        {
            return await enumerator.MoveNextAsync().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (AmiraException exception) when (exception.Category == ErrorCategory.Provider)
        {
            throw;
        }
        catch (HttpRequestException)
        {
            throw Failure(AmiraErrorCodes.NetworkError, "The provider stream could not be read.", true);
        }
        catch (IOException)
        {
            throw Failure(AmiraErrorCodes.NetworkError, "The provider stream could not be read.", true);
        }
    }
}

internal sealed record SseEvent(string? EventName, string Data);

internal static class SseParser
{
    private const int MaxEventBytes = 1024 * 1024;

    public static async IAsyncEnumerable<SseEvent> ParseAsync(
        Stream stream,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        using var reader = new StreamReader(stream, new UTF8Encoding(false, true), detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: false);
        string? eventName = null;
        var data = new StringBuilder();
        int eventBytes = 0;
        bool firstLine = true;
        while (true)
        {
            string? line;
            try
            {
                line = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (DecoderFallbackException)
            {
                throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream was not valid UTF-8.");
            }

            if (line is null) break;
            if (firstLine)
            {
                firstLine = false;
                if (line.StartsWith('\uFEFF')) line = line[1..];
            }
            if (Encoding.UTF8.GetByteCount(line) > MaxEventBytes) throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream event was too large.");
            if (line.Length == 0)
            {
                if (eventName is not null || data.Length > 0)
                    yield return new SseEvent(eventName, data.ToString());
                eventName = null;
                data.Clear();
                eventBytes = 0;
                continue;
            }
            if (line[0] == ':') continue;

            int separator = line.IndexOf(':');
            string field = separator < 0 ? line : line[..separator];
            string value = separator < 0 ? string.Empty : line[(separator + 1)..];
            if (value.StartsWith(' ')) value = value[1..];
            switch (field)
            {
                case "event": eventName = value; break;
                case "data":
                    eventBytes += Encoding.UTF8.GetByteCount(value) + (data.Length > 0 ? 1 : 0);
                    if (eventBytes > MaxEventBytes) throw ProviderHttp.Failure(AmiraErrorCodes.StreamProtocol, "The provider stream event was too large.");
                    if (data.Length > 0) data.Append('\n');
                    data.Append(value);
                    break;
            }
        }

        if (eventName is not null || data.Length > 0)
            yield return new SseEvent(eventName, data.ToString());
    }
}
