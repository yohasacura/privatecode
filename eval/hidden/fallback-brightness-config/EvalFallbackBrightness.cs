using WinOptimizer.Core;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalFallbackBrightness
{
    [Fact]
    public void The_fallback_snapshot_uses_the_configured_brightness()
    {
        var config = new AppConfig();
        var property = typeof(AppConfig).GetProperty("FallbackBrightnessPercent");
        Assert.NotNull(property);
        property!.SetValue(config, 55);
        Assert.Equal(55, OptimizationPlanner.FallbackRestoreSnapshot(config).BrightnessPercent);
    }

    [Fact]
    public void The_default_stays_seventy()
    {
        Assert.Equal(70, typeof(AppConfig).GetProperty("FallbackBrightnessPercent")!.GetValue(new AppConfig()));
        Assert.Equal(70, OptimizationPlanner.FallbackRestoreSnapshot().BrightnessPercent);
    }
}
