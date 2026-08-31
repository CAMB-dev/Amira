using Amira.Client.WinUI;

namespace Amira.Client.WinUI.Tests;

public sealed class MotionPolicyTests
{
    [Fact]
    public void Enabled_system_animations_use_short_theme_and_loading_motion()
    {
        MotionSettings motion = MotionPolicy.ForSystemAnimationPreference(true);

        Assert.True(motion.AnimationsEnabled);
        Assert.Equal(TimeSpan.FromMilliseconds(70), motion.ThemeFadeDuration);
        Assert.True(motion.LoadingPulseDuration > TimeSpan.Zero);
        Assert.True(motion.LoadingPhaseOffset > TimeSpan.Zero);
    }

    [Fact]
    public void Disabled_system_animations_make_all_motion_static()
    {
        MotionSettings motion = MotionPolicy.ForSystemAnimationPreference(false);

        Assert.False(motion.AnimationsEnabled);
        Assert.Equal(TimeSpan.Zero, motion.ThemeFadeDuration);
        Assert.Equal(TimeSpan.Zero, motion.LoadingPulseDuration);
        Assert.Equal(TimeSpan.Zero, motion.LoadingPhaseOffset);
    }
}
