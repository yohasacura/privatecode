using WinOptimizer.Core;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalRiskyServices
{
    [Fact]
    public void Risky_services_are_listed_but_unchecked_and_safe_ones_stay_checked()
    {
        var plan = OptimizationPlanner.BuildPlan(Array.Empty<ProcessInfo>(), new[]
        {
            new ServiceInfo("Tailscale", "Tailscale", true, "Automatic"),
            new ServiceInfo("SysMain", "SysMain", true, "Automatic"),
        });
        var risky = Assert.Single(plan, p => p.Target == "Tailscale");
        Assert.Equal(RiskLevel.Risky, risky.Risk);
        Assert.False(risky.IsChecked);
        var safe = Assert.Single(plan, p => p.Target == "SysMain");
        Assert.Equal(RiskLevel.Safe, safe.Risk);
        Assert.True(safe.IsChecked);
    }
}
