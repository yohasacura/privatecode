using BlackPort.Api.Controllers.Crm;
using Xunit;

namespace BlackPort.Eval.Tests;

public class EvalLeadSources
{
    [Fact]
    public void The_endpoint_exists_on_the_dashboard_controller()
    {
        var action = Reflect.GetAction(typeof(DashboardController), "lead-sources");
        Assert.NotNull(action);
    }

    [Fact]
    public void The_dto_is_a_record_with_source_and_count()
    {
        var dto = Reflect.TypeNamed(typeof(BlackPort.Application.DTOs.Crm.ContactInput).Assembly, "LeadSourceCountDto");
        Assert.Equal(typeof(string), Reflect.Property(dto, "Source").PropertyType);
        Assert.Equal(typeof(int), Reflect.Property(dto, "Count").PropertyType);
    }
}
