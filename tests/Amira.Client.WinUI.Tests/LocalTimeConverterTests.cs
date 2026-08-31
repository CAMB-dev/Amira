using System.Globalization;
using Amira.Client.WinUI;
using Amira.Contracts;
using Amira.Domain;

namespace Amira.Client.WinUI.Tests;

public sealed class LocalTimeConverterTests
{
    [Fact]
    public void Local_and_activity_times_follow_the_current_culture()
    {
        CultureInfo previous = CultureInfo.CurrentCulture;
        CultureInfo.CurrentCulture = CultureInfo.GetCultureInfo("de-DE");
        try
        {
            DateTimeOffset queuedAt = DateTimeOffset.UtcNow;
            string expected = queuedAt.ToLocalTime().ToString("t", CultureInfo.CurrentCulture);

            Assert.Equal(expected, new LocalTimeConverter().Convert(queuedAt, typeof(string), null!, string.Empty));
            Assert.Equal(expected, new TurnActivityTimeConverter().Convert(CreateQueuedTurn(queuedAt), typeof(string), null!, string.Empty));
        }
        finally
        {
            CultureInfo.CurrentCulture = previous;
        }
    }

    private static TurnView CreateQueuedTurn(DateTimeOffset queuedAt) => new(
        BotTurnId.New(),
        BotId.New(),
        DirectChatId.New(),
        ModelProfileId.New(),
        ProviderConnectionId.New(),
        ProviderProtocol.OpenAIResponses,
        "test-model",
        1,
        BotTurnStatus.Queued,
        queuedAt,
        null,
        null,
        null,
        false,
        null,
        null,
        null);
}
