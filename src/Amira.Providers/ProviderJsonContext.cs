using System.Text.Json.Serialization;

namespace Amira.Providers;

[JsonSourceGenerationOptions(DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull)]
[JsonSerializable(typeof(ChatRequestDto))]
[JsonSerializable(typeof(ChatChunkDto))]
[JsonSerializable(typeof(ResponsesRequestDto))]
[JsonSerializable(typeof(ResponsesEventDto))]
[JsonSerializable(typeof(AnthropicRequestDto))]
[JsonSerializable(typeof(AnthropicEventDto))]
[JsonSerializable(typeof(ProviderErrorDto))]
internal partial class ProviderJsonContext : JsonSerializerContext;
