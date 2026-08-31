using Windows.UI.ViewManagement;

namespace Amira.Client.WinUI;

public readonly record struct MotionSettings(
    bool AnimationsEnabled,
    TimeSpan ThemeFadeDuration,
    TimeSpan LoadingPulseDuration,
    TimeSpan LoadingPhaseOffset);

public static class MotionPolicy
{
    public static MotionSettings Current => ForSystemAnimationPreference(new UISettings().AnimationsEnabled);

    public static MotionSettings ForSystemAnimationPreference(bool animationsEnabled) => animationsEnabled
        ? new(true, TimeSpan.FromMilliseconds(70), TimeSpan.FromMilliseconds(440), TimeSpan.FromMilliseconds(150))
        : new(false, TimeSpan.Zero, TimeSpan.Zero, TimeSpan.Zero);
}
