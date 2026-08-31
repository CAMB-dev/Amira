using Amira.Domain;
using Amira.Errors;
using Amira.Runtime;

namespace Amira.Client.WinUI.Tests;

public sealed class ClientProjectionTests
{
    [Fact]
    public void Projection_aggregates_deltas_usage_and_terminal_content()
    {
        BotTurnId turnId = BotTurnId.New();
        BotId botId = BotId.New();
        var projection = new RuntimeEventProjection();
        projection.Apply(new ChatRuntimeEvent.Started(turnId, botId, ProviderProtocol.OpenAIResponses, "gpt-test"));
        projection.Apply(new ChatRuntimeEvent.TextDelta(turnId, botId, ProviderProtocol.OpenAIResponses, "gpt-test", "hel"));
        RuntimeTurnProjection live = projection.Apply(new ChatRuntimeEvent.UsageReported(turnId, botId, ProviderProtocol.OpenAIResponses, "gpt-test", new(3, 1)));
        RuntimeTurnProjection terminal = projection.Apply(new ChatRuntimeEvent.Completed(turnId, botId, ProviderProtocol.OpenAIResponses, "gpt-test", "hello", new(4, 2)));
        Assert.Equal("hel", live.Text);
        Assert.Equal(3, live.Usage?.InputTokens);
        Assert.True(terminal.IsTerminal);
        Assert.Equal("hello", terminal.Text);
        Assert.Equal(2, terminal.Usage?.OutputTokens);
    }

    [Fact]
    public void Product_error_is_safe_and_includes_its_code()
    {
        string message = ErrorPresentation.For(new AmiraException(new("input_invalid", ErrorCategory.Input, "Use a valid value.")));
        Assert.Equal("Use a valid value. (input_invalid)", message);
        Assert.Equal("Something unexpected went wrong. Please try again.", ErrorPresentation.For(new InvalidOperationException("secret value")));
    }

    [Fact]
    public void Selection_generation_rejects_an_older_load_result()
    {
        var coordinator = new SelectionCoordinator();
        BotId firstBot = BotId.New();
        long firstGeneration = coordinator.Next();
        BotId selectedBot = BotId.New();
        long secondGeneration = coordinator.Next();
        Assert.False(coordinator.IsCurrent(firstGeneration, selectedBot, firstBot));
        Assert.True(coordinator.IsCurrent(secondGeneration, selectedBot, selectedBot));
    }

    [Fact]
    public void Terminal_projection_can_be_forgotten_after_durable_refresh()
    {
        BotTurnId turnId = BotTurnId.New();
        var projection = new RuntimeEventProjection();
        projection.Apply(new ChatRuntimeEvent.Completed(turnId, BotId.New(), ProviderProtocol.AnthropicMessages, "claude-test", "done", null));
        Assert.Equal(1, projection.ActiveCount);
        projection.Forget(turnId);
        Assert.Equal(0, projection.ActiveCount);
    }
}
