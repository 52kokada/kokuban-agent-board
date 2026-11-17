namespace Kokuban.Core;

public static class PillVisibility
{
    public static bool ShouldReveal(bool cardOpen, bool pointerNear) => cardOpen || pointerNear;
}
