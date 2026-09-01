using Observatory.Sample;

namespace Observatory.Sample.Tests;

[TestClass]
public sealed class ArithmeticTests
{
    [TestMethod]
    public void Add_TwoPositiveNumbers_ReturnsSum()
    {
        Assert.AreEqual(5, Calculator.Add(2, 3));
    }

    [TestMethod]
    [DataRow(10, 4, 6)]
    [DataRow(-2, -3, 1)]
    public void Subtract_ValidInputs_ReturnsDifference(int left, int right, int expected)
    {
        Assert.AreEqual(expected, Calculator.Subtract(left, right));
    }

    [TestMethod]
    [Ignore("Used to verify skipped-state rendering")]
    public void DeferredScenario_IsReportedAsSkipped()
    {
        Assert.Fail("Ignored tests must not execute.");
    }
}
