using BlackPort.Domain.Entities;
using Xunit;

namespace BlackPort.Eval.Tests;

public class EvalQuoteCostTotal
{
    [Fact]
    public void CostTotal_sums_the_lines_and_is_not_a_column()
    {
        var quote = new Quote();
        quote.Lines.Add(new QuoteLine { Name = "a", Amount = 10.5m, Currency = "EUR" });
        quote.Lines.Add(new QuoteLine { Name = "b", Amount = 4.5m, Currency = "USD" });
        var property = Reflect.Property(typeof(Quote), "CostTotal");
        Assert.Equal(typeof(decimal), property.PropertyType);
        Assert.Equal(15m, (decimal)property.GetValue(quote)!);
        Assert.True(Reflect.HasAttribute(property, "NotMappedAttribute"), "CostTotal must be [NotMapped]");
    }

    [Fact]
    public void No_lines_means_zero()
    {
        Assert.Equal(0m, (decimal)Reflect.Property(typeof(Quote), "CostTotal").GetValue(new Quote())!);
    }
}
