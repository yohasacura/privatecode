using WinOptimizer.Core;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalMaxProcesses
{
    private static AppConfig WithMax(int n)
    {
        var config = new AppConfig();
        var property = typeof(AppConfig).GetProperty("MaxProcessesInPlan");
        Assert.NotNull(property);
        property!.SetValue(config, n);
        return config;
    }

    private static ProcessInfo[] ThreeBloatProcesses() => new[]
    {
        new ProcessInfo(1, "Discord", false), new ProcessInfo(2, "Spotify", false), new ProcessInfo(3, "Slack", false),
    };

    [Fact]
    public void Zero_means_unlimited()
    {
        var plan = OptimizationPlanner.BuildPlan(ThreeBloatProcesses(), Array.Empty<ServiceInfo>(), WithMax(0));
        Assert.Equal(3, plan.Count(p => p.Category == ActionCategory.Process));
    }

    [Fact]
    public void A_cap_keeps_the_first_n_process_items_and_everything_else()
    {
        var plan = OptimizationPlanner.BuildPlan(ThreeBloatProcesses(), Array.Empty<ServiceInfo>(), WithMax(2));
        Assert.Equal(2, plan.Count(p => p.Category == ActionCategory.Process));
        Assert.Contains(plan, p => p.Category == ActionCategory.Power);
        Assert.Contains(plan, p => p.Category == ActionCategory.Brightness);
        Assert.Contains(plan, p => p.Category == ActionCategory.VisualEffects);
    }

    [Fact]
    public void The_default_is_zero()
    {
        Assert.Equal(0, typeof(AppConfig).GetProperty("MaxProcessesInPlan")!.GetValue(new AppConfig()));
    }
}
