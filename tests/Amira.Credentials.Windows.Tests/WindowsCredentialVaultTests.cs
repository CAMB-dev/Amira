using Amira.Domain;
using Amira.Errors;

namespace Amira.Credentials.Windows.Tests;

public sealed class WindowsCredentialVaultTests
{
    [Fact]
    public async Task StoreResolveDelete_RoundTripsAndLeavesNoCredential()
    {
        var vault = new WindowsCredentialVault();
        CredentialReference reference = UniqueReference();
        string secret = $"amira-test-{Guid.NewGuid():N}-密钥";

        try
        {
            await vault.StoreAsync(reference, secret, TestContext.Current.CancellationToken);

            string? resolved = await vault.ResolveAsync(reference, TestContext.Current.CancellationToken);

            Assert.Equal(secret, resolved);
        }
        finally
        {
            await vault.DeleteAsync(reference, CancellationToken.None);
        }

        Assert.Null(await vault.ResolveAsync(reference, TestContext.Current.CancellationToken));
    }

    [Fact]
    public async Task MissingResolveReturnsNullAndDeleteIsIdempotent()
    {
        var vault = new WindowsCredentialVault();
        CredentialReference reference = UniqueReference();

        Assert.Null(await vault.ResolveAsync(reference, TestContext.Current.CancellationToken));
        await vault.DeleteAsync(reference, TestContext.Current.CancellationToken);
        await vault.DeleteAsync(reference, TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task EmptyReferenceIsConfigurationError()
    {
        var vault = new WindowsCredentialVault();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(async () =>
            await vault.ResolveAsync(default, TestContext.Current.CancellationToken));

        Assert.Equal(AmiraErrorCodes.CredentialVaultInvalidConfiguration, exception.Code);
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    public async Task BlankSecretIsConfigurationError(string secret)
    {
        var vault = new WindowsCredentialVault();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(async () =>
            await vault.StoreAsync(UniqueReference(), secret, TestContext.Current.CancellationToken));

        Assert.Equal(AmiraErrorCodes.CredentialVaultInvalidConfiguration, exception.Code);
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
    }

    [Fact]
    public async Task OversizedUtf8SecretIsConfigurationError()
    {
        var vault = new WindowsCredentialVault();

        AmiraException exception = await Assert.ThrowsAsync<AmiraException>(async () =>
            await vault.StoreAsync(UniqueReference(), new string('x', (5 * 512) + 1), TestContext.Current.CancellationToken));

        Assert.Equal(AmiraErrorCodes.CredentialVaultInvalidConfiguration, exception.Code);
        Assert.Equal(ErrorCategory.Configuration, exception.Category);
    }

    private static CredentialReference UniqueReference() =>
        CredentialReference.Create($"tests/{Guid.NewGuid():N}");
}
