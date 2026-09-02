using WinOptimizer.Core;
using WinOptimizer.Services;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalSnapshotSavedAt : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "WinOptEval_" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void A_saved_snapshot_says_when_it_was_saved()
    {
        var store = new SnapshotStore(_dir);
        var before = DateTimeOffset.Now;
        Assert.True(store.SaveSnapshot(new Snapshot { BrightnessPercent = 42 }));
        var back = store.LoadSnapshot();
        Assert.NotNull(back);
        var property = typeof(Snapshot).GetProperty("SavedAt");
        Assert.NotNull(property);
        var savedAt = (DateTimeOffset)property!.GetValue(back)!;
        Assert.True(savedAt >= before.AddMinutes(-1) && savedAt <= DateTimeOffset.Now.AddMinutes(1), $"SavedAt was {savedAt}");
        Assert.Equal(42, back!.BrightnessPercent);
    }
}
