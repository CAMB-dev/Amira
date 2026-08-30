using Amira.Errors;

namespace Amira.Errors.Tests;

public sealed class AmiraErrorTests
{
    [Fact]
    public void Product_error_carries_its_values_unchanged()
    {
        var error = new AmiraError("provider_timeout", ErrorCategory.Provider, $"  Request\n timed\t out {new string('x', 600)}", true);

        Assert.Equal("provider_timeout", error.Code);
        Assert.Equal(ErrorCategory.Provider, error.Category);
        Assert.True(error.IsTransient);
        Assert.Equal("  Request\n timed\t out " + new string('x', 600), error.Message);
    }

    [Fact]
    public void Exception_exposes_only_the_typed_error_contract()
    {
        var error = new AmiraError("bot_not_found", ErrorCategory.NotFound, "The requested Bot was not found.");
        var exception = new AmiraException(error);

        Assert.Equal(error, exception.Error);
        Assert.Equal(error.Code, exception.Code);
        Assert.Equal(error.Message, exception.Message);
    }
}
