using System.Text.Json.Serialization;

namespace Amira.Providers;

internal sealed class ChatRequestDto
{
    [JsonPropertyName("model")] public string Model { get; init; } = string.Empty;
    [JsonPropertyName("messages")] public ChatMessageDto[] Messages { get; init; } = [];
    [JsonPropertyName("stream")] public bool Stream { get; init; }
    [JsonPropertyName("stream_options")] public ChatStreamOptionsDto? StreamOptions { get; init; }
    [JsonPropertyName("temperature")] public double? Temperature { get; init; }
    [JsonPropertyName("max_completion_tokens")] public int? MaxCompletionTokens { get; init; }
    [JsonPropertyName("max_tokens")] public int? MaxTokens { get; init; }
}

internal sealed class ChatMessageDto
{
    [JsonPropertyName("role")] public string Role { get; init; } = string.Empty;
    [JsonPropertyName("content")] public string Content { get; init; } = string.Empty;
}

internal sealed class ChatStreamOptionsDto
{
    [JsonPropertyName("include_usage")] public bool IncludeUsage { get; init; }
}

internal sealed class ChatChunkDto
{
    [JsonPropertyName("choices")] public ChatChoiceDto[]? Choices { get; init; }
    [JsonPropertyName("usage")] public ChatUsageDto? Usage { get; init; }
}

internal sealed class ChatChoiceDto
{
    [JsonPropertyName("index")] public int Index { get; init; }
    [JsonPropertyName("delta")] public ChatDeltaDto? Delta { get; init; }
    [JsonPropertyName("finish_reason")] public string? FinishReason { get; init; }
}

internal sealed class ChatDeltaDto
{
    [JsonPropertyName("content")] public string? Content { get; init; }
    [JsonPropertyName("refusal")] public string? Refusal { get; init; }
}

internal sealed class ChatUsageDto
{
    [JsonPropertyName("prompt_tokens")] public int? PromptTokens { get; init; }
    [JsonPropertyName("completion_tokens")] public int? CompletionTokens { get; init; }
}

internal sealed class ResponsesRequestDto
{
    [JsonPropertyName("model")] public string Model { get; init; } = string.Empty;
    [JsonPropertyName("instructions")] public string? Instructions { get; init; }
    [JsonPropertyName("input")] public ResponsesInputDto[] Input { get; init; } = [];
    [JsonPropertyName("stream")] public bool Stream { get; init; }
    [JsonPropertyName("store")] public bool Store { get; init; }
    [JsonPropertyName("temperature")] public double? Temperature { get; init; }
    [JsonPropertyName("max_output_tokens")] public int? MaxOutputTokens { get; init; }
}

internal sealed class ResponsesInputDto
{
    [JsonPropertyName("type")] public string Type { get; init; } = "message";
    [JsonPropertyName("role")] public string Role { get; init; } = string.Empty;
    [JsonPropertyName("content")] public ResponsesTextDto[] Content { get; init; } = [];
}

internal sealed class ResponsesTextDto
{
    [JsonPropertyName("type")] public string Type { get; init; } = "input_text";
    [JsonPropertyName("text")] public string Text { get; init; } = string.Empty;
}

internal sealed class ResponsesEventDto
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("delta")] public string? Delta { get; init; }
    [JsonPropertyName("response")] public ResponsesResponseDto? Response { get; init; }
    [JsonPropertyName("code")] public string? Code { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
}

internal sealed class ResponsesResponseDto
{
    [JsonPropertyName("status")] public string? Status { get; init; }
    [JsonPropertyName("usage")] public ResponsesUsageDto? Usage { get; init; }
    [JsonPropertyName("error")] public ProviderErrorDetailDto? Error { get; init; }
}

internal sealed class ResponsesUsageDto
{
    [JsonPropertyName("input_tokens")] public int? InputTokens { get; init; }
    [JsonPropertyName("output_tokens")] public int? OutputTokens { get; init; }
}

internal sealed class AnthropicRequestDto
{
    [JsonPropertyName("model")] public string Model { get; init; } = string.Empty;
    [JsonPropertyName("max_tokens")] public int MaxTokens { get; init; }
    [JsonPropertyName("system")] public string? System { get; init; }
    [JsonPropertyName("messages")] public AnthropicMessageDto[] Messages { get; init; } = [];
    [JsonPropertyName("stream")] public bool Stream { get; init; }
    [JsonPropertyName("temperature")] public double? Temperature { get; init; }
}

internal sealed class AnthropicMessageDto
{
    [JsonPropertyName("role")] public string Role { get; init; } = string.Empty;
    [JsonPropertyName("content")] public string Content { get; init; } = string.Empty;
}

internal sealed class AnthropicEventDto
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("message")] public AnthropicMessageStartDto? Message { get; init; }
    [JsonPropertyName("content_block")] public AnthropicContentBlockDto? ContentBlock { get; init; }
    [JsonPropertyName("delta")] public AnthropicDeltaDto? Delta { get; init; }
    [JsonPropertyName("usage")] public AnthropicUsageDto? Usage { get; init; }
    [JsonPropertyName("error")] public ProviderErrorDetailDto? Error { get; init; }
}

internal sealed class AnthropicContentBlockDto
{
    [JsonPropertyName("type")] public string? Type { get; init; }
}

internal sealed class AnthropicMessageStartDto
{
    [JsonPropertyName("usage")] public AnthropicUsageDto? Usage { get; init; }
}

internal sealed class AnthropicDeltaDto
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("text")] public string? Text { get; init; }
    [JsonPropertyName("stop_reason")] public string? StopReason { get; init; }
}

internal sealed class AnthropicUsageDto
{
    [JsonPropertyName("input_tokens")] public int? InputTokens { get; init; }
    [JsonPropertyName("output_tokens")] public int? OutputTokens { get; init; }
    [JsonPropertyName("cache_creation_input_tokens")] public int? CacheCreationInputTokens { get; init; }
    [JsonPropertyName("cache_read_input_tokens")] public int? CacheReadInputTokens { get; init; }
}

internal sealed class ProviderErrorDto
{
    [JsonPropertyName("error")] public ProviderErrorDetailDto? Error { get; init; }
}

internal sealed class ProviderErrorDetailDto
{
    [JsonPropertyName("type")] public string? Type { get; init; }
    [JsonPropertyName("code")] public string? Code { get; init; }
    [JsonPropertyName("message")] public string? Message { get; init; }
}
