using WinOptimizer.ViewModels;
using Xunit;

namespace WinOptimizer.Tests.Eval;

public class EvalRelayCommand
{
    [Fact]
    public void A_command_without_a_predicate_can_execute()
    {
        Assert.True(new RelayCommand(() => { }).CanExecute(null));
        Assert.True(new RelayCommand<int>(_ => { }).CanExecute(null));
    }

    [Fact]
    public void A_predicate_still_decides()
    {
        Assert.False(new RelayCommand(() => { }, () => false).CanExecute(null));
        Assert.True(new RelayCommand(() => { }, () => true).CanExecute(null));
        Assert.False(new RelayCommand<int>(_ => { }, () => false).CanExecute(null));
    }
}
