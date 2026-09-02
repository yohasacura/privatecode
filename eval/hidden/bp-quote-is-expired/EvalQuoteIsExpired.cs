using BlackPort.Domain.Entities;
using Xunit;

namespace BlackPort.Eval.Tests;

public class EvalQuoteIsExpired
{
    private static bool IsExpired(Quote q) => (bool)Reflect.Property(typeof(Quote), "IsExpired").GetValue(q)!;

    [Fact]
    public void Past_is_expired_future_and_unset_are_not()
    {
        Assert.True(IsExpired(new Quote { ValidUntilUtc = DateTime.UtcNow.AddDays(-1) }));
        Assert.False(IsExpired(new Quote { ValidUntilUtc = DateTime.UtcNow.AddDays(1) }));
        Assert.False(IsExpired(new Quote { ValidUntilUtc = null }));
    }

    [Fact]
    public void It_is_not_a_column()
    {
        Assert.True(Reflect.HasAttribute(Reflect.Property(typeof(Quote), "IsExpired"), "NotMappedAttribute"), "IsExpired must be [NotMapped]");
    }
}
