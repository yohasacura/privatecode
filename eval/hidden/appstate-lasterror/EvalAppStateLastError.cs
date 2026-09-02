using WinOptimizer.Core;
using WinOptimizer.Services;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalAppStateLastError : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "WinOptEval_" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void LastError_persists_through_save_and_load()
    {
        var property = typeof(AppState).GetProperty("LastError");
        Assert.NotNull(property);
        var store = new SnapshotStore(_dir);
        var state = new AppState { IsOptimized = true, RestoreAttempts = 2 };
        property!.SetValue(state, "powercfg failed");
        store.SaveState(state);
        var back = store.LoadState();
        Assert.Equal("powercfg failed", property.GetValue(back));
        Assert.True(back.IsOptimized);
        Assert.Equal(2, back.RestoreAttempts);
    }

    [Fact]
    public void LastError_is_null_by_default()
    {
        Assert.Null(typeof(AppState).GetProperty("LastError")!.GetValue(new AppState()));
    }
}
