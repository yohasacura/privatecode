using WinOptimizer.Core;
using WinOptimizer.Services;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalSecondSave : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "WinOptEval_" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void Saving_twice_keeps_the_latest_and_leaves_no_temp_files()
    {
        var store = new SnapshotStore(_dir);
        Assert.True(store.SaveSnapshot(new Snapshot { BrightnessPercent = 1 }));
        Assert.True(store.SaveSnapshot(new Snapshot { BrightnessPercent = 2 }));
        Assert.True(store.SaveSnapshot(new Snapshot { BrightnessPercent = 3 }));
        Assert.Equal(3, store.LoadSnapshot()!.BrightnessPercent);
        Assert.Empty(Directory.GetFiles(_dir, "*.tmp"));
    }
}
