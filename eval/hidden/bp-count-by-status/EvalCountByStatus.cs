using BlackPort.Api.Controllers.Crm;
using Xunit;

namespace BlackPort.Eval.Tests;

public class EvalCountByStatus
{
    [Fact]
    public void The_endpoint_exists_on_the_leads_controller()
    {
        var action = Reflect.GetAction(typeof(LeadsController), "count-by-status");
        Assert.NotNull(action);
    }

    [Fact]
    public void The_dto_is_a_record_with_the_three_fields()
    {
        var dto = Reflect.TypeNamed(typeof(BlackPort.Application.DTOs.Crm.ContactInput).Assembly, "LeadStatusCountDto");
        Assert.Equal(typeof(Guid), Reflect.Property(dto, "StatusId").PropertyType);
        Assert.Equal(typeof(string), Reflect.Property(dto, "StatusName").PropertyType);
        Assert.Equal(typeof(int), Reflect.Property(dto, "Count").PropertyType);
    }
}
