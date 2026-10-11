using System.Diagnostics;
using Windows.Media.Control;

namespace JizuraSpotify;

/// <summary>What Spotify is playing, read from the Windows media session (GSMTC). Ported from SpotifyLyrics.</summary>
public sealed record NowState(bool Found, string Title, string Artist, string Album, double Duration, double Position, bool Playing, double Rate)
{
    public static readonly NowState None = new(false, "", "", "", 0, 0, false, 1);
}

public sealed class NowPlaying
{
    private GlobalSystemMediaTransportControlsSessionManager? manager;
    private readonly object gate = new();
    private NowState state = NowState.None;
    private long anchor = Stopwatch.GetTimestamp();   // when state.Position was true
    public string? LastError { get; private set; }

    public async Task RunAsync(CancellationToken token)
    {
        try { manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync(); }
        catch (Exception ex) { LastError = "Windows の再生情報を取得できません: " + ex.Message; return; }
        while (!token.IsCancellationRequested)
        {
            try { await PollAsync(); LastError = null; }
            catch (Exception ex) { LastError = "再生情報の取得に失敗: " + ex.Message; }
            try { await Task.Delay(250, token); } catch (OperationCanceledException) { break; }
        }
    }

    private async Task PollAsync()
    {
        var session = manager?.GetSessions().FirstOrDefault(s => s.SourceAppUserModelId.Contains("spotify", StringComparison.OrdinalIgnoreCase));
        if (session is null) { Set(NowState.None); return; }
        var media = await session.TryGetMediaPropertiesAsync();
        var timeline = session.GetTimelineProperties();
        var info = session.GetPlaybackInfo();
        var playing = info.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
        var rate = info.PlaybackRate ?? 1;
        // Spotify only updates the timeline on play / pause / seek: extrapolate from when it was last updated
        var age = timeline.LastUpdatedTime == default ? 0 : Math.Max(0, (DateTimeOffset.UtcNow - timeline.LastUpdatedTime).TotalSeconds);
        var position = timeline.Position.TotalSeconds + (playing ? age * rate : 0);
        var duration = timeline.EndTime.TotalSeconds;
        if (duration > 0) position = Math.Min(position, duration);
        Set(new NowState(true, media.Title ?? "", media.Artist ?? "", media.AlbumTitle ?? "", duration, position, playing, rate));
    }

    private void Set(NowState next)
    {
        lock (gate) { state = next; anchor = Stopwatch.GetTimestamp(); }
    }

    /// <summary>The state with the position moved on to "now".</summary>
    public NowState Snapshot()
    {
        lock (gate)
        {
            if (!state.Found || !state.Playing) return state;
            var pos = state.Position + Stopwatch.GetElapsedTime(anchor).TotalSeconds * state.Rate;
            if (state.Duration > 0) pos = Math.Min(pos, state.Duration);
            return state with { Position = pos };
        }
    }
}
