using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace Amira.Client.WinUI;

internal static class ContentDialogChrome
{
    public static void Apply(ContentDialog dialog, XamlRoot xamlRoot)
    {
        ArgumentNullException.ThrowIfNull(dialog);
        ArgumentNullException.ThrowIfNull(xamlRoot);

        dialog.XamlRoot = xamlRoot;
        dialog.RequestedTheme = ResolveTheme(xamlRoot);
    }

    private static ElementTheme ResolveTheme(XamlRoot xamlRoot) =>
        xamlRoot.Content is FrameworkElement root ? root.ActualTheme : ElementTheme.Default;
}
