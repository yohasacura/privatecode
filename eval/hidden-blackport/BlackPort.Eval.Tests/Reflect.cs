using System.Reflection;
using Microsoft.AspNetCore.Mvc.Routing;
using Xunit;

namespace BlackPort.Eval.Tests;

/// <summary>What every hidden test reaches for: a member by name, an action by its route.</summary>
public static class Reflect
{
    public static PropertyInfo Property(Type type, string name)
    {
        var p = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
        Assert.True(p is not null, $"{type.Name} has no public property {name}");
        return p!;
    }

    public static Type TypeNamed(Assembly assembly, string simpleName)
    {
        var t = assembly.GetTypes().FirstOrDefault(x => x.Name == simpleName);
        Assert.True(t is not null, $"{assembly.GetName().Name} declares no type {simpleName}");
        return t!;
    }

    /// <summary>The action whose GET route template is <paramref name="template"/>, on the controller.</summary>
    public static MethodInfo GetAction(Type controller, string template)
    {
        foreach (var m in controller.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
        {
            foreach (var attr in m.GetCustomAttributes(inherit: true).OfType<HttpMethodAttribute>())
            {
                if (attr.HttpMethods.Contains("GET") && string.Equals(attr.Template, template, StringComparison.OrdinalIgnoreCase))
                    return m;
            }
        }
        Assert.Fail($"{controller.Name} has no GET action routed at \"{template}\"");
        return null!;
    }

    public static bool HasAttribute(MemberInfo member, string attributeSimpleName) =>
        member.GetCustomAttributes(inherit: true).Any(a => a.GetType().Name == attributeSimpleName);
}
