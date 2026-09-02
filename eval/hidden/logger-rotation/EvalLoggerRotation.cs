using WinOptimizer.Services;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalLoggerRotation : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "WinOptEval_" + Guid.NewGuid().ToString("N"));
    public void Dispose() { try { Directory.Delete(_dir, true); } catch { } }

    [Fact]
    public void A_log_past_the_limit_is_moved_aside_and_a_fresh_one_started()
    {
        var ctor = typeof(FileLogger).GetConstructor(new[] { typeof(string), typeof(long) });
        Assert.NotNull(ctor);
        using (var logger = (FileLogger)ctor!.Invoke(new object?[] { _dir, 200L }))
        {
            for (var i = 0; i < 20; i++) logger.Info("line number " + i + " " + new string('x', 30));
        }
        Assert.True(File.Exists(Path.Combine(_dir, "log.1.txt")), "log.1.txt was not created");
        Assert.True(new FileInfo(Path.Combine(_dir, "log.txt")).Length < 400, "log.txt kept growing past the limit");
    }

    [Fact]
    public void The_old_constructor_shape_still_works()
    {
        using var logger = new FileLogger(_dir);
        logger.Info("hello");
        Assert.True(File.Exists(Path.Combine(_dir, "log.txt")));
    }
}
