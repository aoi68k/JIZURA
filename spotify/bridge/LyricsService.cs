using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace JizuraSpotify;

public record LyricsResult(string? SyncedLyrics, string? PlainLyrics, bool Instrumental);

/// <summary>
/// LRCLIB lyrics lookup with title normalization and disk cache.
/// Uses LRCLIB's official open public API (https://lrclib.net/docs).
/// </summary>
public sealed class LyricsService : IDisposable
{
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly string cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JizuraSpotify", "cache");
    private static readonly JsonSerializerOptions JsonOptions = new() { PropertyNameCaseInsensitive = true };

    private record LrclibHit(string? TrackName, string? ArtistName, double Duration, string? SyncedLyrics, string? PlainLyrics, bool Instrumental);

    public LyricsService()
    {
        client.DefaultRequestHeaders.UserAgent.ParseAdd("JIZURA-spotify-view/0.1 (+https://github.com/852wa/JIZURA)");
    }

    public async Task<LyricsResult?> GetAsync(string title, string artist, string album, double duration, bool refresh, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;

        var key = $"{title}\n{artist}\n{album}\n{duration:F0}";
        Directory.CreateDirectory(cache);
        var path = Path.Combine(cache, Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))) + ".json");

        if (!refresh && File.Exists(path))
        {
            try
            {
                var cached = JsonSerializer.Deserialize<LyricsResult>(await File.ReadAllTextAsync(path, token), JsonOptions);
                if (cached is not null) return cached;
            }
            catch (JsonException) { /* refetch a damaged cache file */ }
        }

        var cleanTitle = CleanTitle(title);
        var cleanArtist = CleanArtist(artist);
        var dur = duration > 0 ? "&duration=" + duration.ToString("F0", CultureInfo.InvariantCulture) : "";

        LyricsResult? result = null;

        // 1. Exact match attempts (title/artist/album, then without album, then with normalized title)
        string GetUrl(string t, string a, string al) =>
            "https://lrclib.net/api/get?track_name=" + Uri.EscapeDataString(t)
            + "&artist_name=" + Uri.EscapeDataString(a)
            + (al.Length > 0 ? "&album_name=" + Uri.EscapeDataString(al) : "") + dur;

        var attempts = new List<(string t, string a, string al)>
        {
            (title, artist, album),
            (title, artist, "")
        };
        if (!string.Equals(cleanTitle, title, StringComparison.OrdinalIgnoreCase) || !string.Equals(cleanArtist, artist, StringComparison.OrdinalIgnoreCase))
        {
            attempts.Add((cleanTitle, cleanArtist, ""));
        }

        foreach (var (t, a, al) in attempts)
        {
            using var response = await GetWithRetryAsync(GetUrl(t, a, al), token);
            if (response is not null && response.IsSuccessStatusCode)
            {
                var hit = JsonSerializer.Deserialize<LrclibHit>(await response.Content.ReadAsStringAsync(token), JsonOptions);
                if (hit is not null)
                {
                    result = new LyricsResult(hit.SyncedLyrics, hit.PlainLyrics, hit.Instrumental);
                    if (!string.IsNullOrWhiteSpace(result.SyncedLyrics)) break;
                }
            }
        }

        // 2. Search fallback if synced lyrics were not found
        if (result is null || string.IsNullOrWhiteSpace(result.SyncedLyrics))
        {
            var searchQueries = new List<string>
            {
                "https://lrclib.net/api/search?track_name=" + Uri.EscapeDataString(title) + "&artist_name=" + Uri.EscapeDataString(artist)
            };
            if (!string.Equals(cleanTitle, title, StringComparison.OrdinalIgnoreCase))
            {
                searchQueries.Add("https://lrclib.net/api/search?q=" + Uri.EscapeDataString($"{cleanTitle} {cleanArtist}"));
            }

            foreach (var url in searchQueries)
            {
                using var response = await GetWithRetryAsync(url, token);
                if (response is not null && response.IsSuccessStatusCode)
                {
                    var hits = JsonSerializer.Deserialize<List<LrclibHit>>(await response.Content.ReadAsStringAsync(token), JsonOptions) ?? [];

                    // Prefer synced lyrics matching duration within +-4 seconds
                    var bestSynced = hits
                        .Where(h => !string.IsNullOrWhiteSpace(h.SyncedLyrics) && (duration <= 0 || Math.Abs(h.Duration - duration) <= 4))
                        .OrderBy(h => duration > 0 ? Math.Abs(h.Duration - duration) : 0)
                        .FirstOrDefault();

                    if (bestSynced is not null)
                    {
                        result = new LyricsResult(bestSynced.SyncedLyrics, bestSynced.PlainLyrics, bestSynced.Instrumental);
                        break;
                    }

                    // Otherwise pick plain lyrics hit as fallback
                    if (result is null)
                    {
                        var bestPlain = hits.FirstOrDefault(h => !string.IsNullOrWhiteSpace(h.PlainLyrics));
                        if (bestPlain is not null)
                        {
                            result = new LyricsResult(null, bestPlain.PlainLyrics, bestPlain.Instrumental);
                        }
                    }
                }
            }
        }

        if (result is not null)
        {
            try
            {
                var temp = path + ".tmp";
                await File.WriteAllTextAsync(temp, JsonSerializer.Serialize(result), token);
                File.Move(temp, path, true);
            }
            catch { /* ignore cache write errors */ }
        }

        return result;
    }

    private static string CleanTitle(string title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "";
        // Remove brackets: (), [], 【】, （）, etc.
        var s = Regex.Replace(title, @"\s*[\(\[（【][^\)\]）】]*[\)\]）】]", " ");
        // Remove trailing version/remaster/karaoke split by dash or tilde: " - Original Karaoke", " - Remastered", etc.
        var parts = Regex.Split(s, @"\s+[-–—~〜]\s+");
        if (parts.Length > 1 && !string.IsNullOrWhiteSpace(parts[0]))
        {
            s = parts[0];
        }
        return Regex.Replace(s, @"\s+", " ").Trim();
    }

    private static string CleanArtist(string artist)
    {
        if (string.IsNullOrWhiteSpace(artist)) return "";
        var parts = artist.Split(new[] { ',', '&', '/' }, StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length > 0 && !string.IsNullOrWhiteSpace(parts[0]))
        {
            var primary = parts[0].Trim();
            var featIdx = primary.IndexOf(" feat", StringComparison.OrdinalIgnoreCase);
            if (featIdx > 0) primary = primary[..featIdx].Trim();
            return primary;
        }
        return artist.Trim();
    }

    private async Task<HttpResponseMessage?> GetWithRetryAsync(string url, CancellationToken token)
    {
        for (var attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                var response = await client.GetAsync(url, token);
                if (response.StatusCode == HttpStatusCode.NotFound) return response;
                if ((int)response.StatusCode == 503 || (int)response.StatusCode == 429 || (int)response.StatusCode >= 500)
                {
                    var delay = response.Headers.RetryAfter?.Delta ?? TimeSpan.FromMilliseconds(800 * (attempt + 1));
                    response.Dispose();
                    if (attempt < 2)
                    {
                        await Task.Delay(delay, token);
                        continue;
                    }
                    return null;
                }
                return response;
            }
            catch (HttpRequestException) when (attempt < 2)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(800 * (attempt + 1)), token);
            }
        }
        return null;
    }

    public void Dispose() => client.Dispose();
}
