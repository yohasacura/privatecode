using System.Globalization;
using System.Windows;
using System.Windows.Data;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalBoolToVisibility
{
    private static IValueConverter Make()
    {
        var type = typeof(WinOptimizer.Core.Snapshot).Assembly.GetType("WinOptimizer.Converters.BoolToVisibilityConverter");
        Assert.NotNull(type);
        return (IValueConverter)Activator.CreateInstance(type!)!;
    }

    [Fact]
    public void True_is_visible_and_everything_else_is_collapsed()
    {
        var c = Make();
        Assert.Equal(Visibility.Visible, c.Convert(true, typeof(Visibility), null!, CultureInfo.InvariantCulture));
        Assert.Equal(Visibility.Collapsed, c.Convert(false, typeof(Visibility), null!, CultureInfo.InvariantCulture));
        Assert.Equal(Visibility.Collapsed, c.Convert("not a bool", typeof(Visibility), null!, CultureInfo.InvariantCulture));
    }

    [Fact]
    public void Visible_converts_back_to_true()
    {
        var c = Make();
        Assert.Equal(true, c.ConvertBack(Visibility.Visible, typeof(bool), null!, CultureInfo.InvariantCulture));
        Assert.Equal(false, c.ConvertBack(Visibility.Collapsed, typeof(bool), null!, CultureInfo.InvariantCulture));
    }
}
