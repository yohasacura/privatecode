using System.Text.Json;
using WinOptimizer.Core;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalServiceCount
{
    [Fact]
    public void ServiceCount_counts_and_stays_out_of_the_json()
    {
        var snap = new Snapshot
        {
            Services = { new ServiceSnapshot { Name = "A" }, new ServiceSnapshot { Name = "B" } },
        };
        var property = typeof(Snapshot).GetProperty("ServiceCount");
        Assert.NotNull(property);
        Assert.Equal(2, property!.GetValue(snap));
        var json = JsonSerializer.Serialize(snap);
        Assert.DoesNotContain("ServiceCount", json);
        var back = JsonSerializer.Deserialize<Snapshot>(json)!;
        Assert.Equal(2, back.Services.Count);
    }

    [Fact]
    public void Older_files_without_the_property_still_load()
    {
        var back = JsonSerializer.Deserialize<Snapshot>("{\"BrightnessPercent\":40,\"Services\":[]}")!;
        Assert.Equal(40, back.BrightnessPercent);
        Assert.Equal(0, typeof(Snapshot).GetProperty("ServiceCount")!.GetValue(back));
    }
}
