using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace JizuraBluesky;

public class BlueskyPost
{
    [JsonPropertyName("uri")]
    public string Uri { get; set; } = "";

    [JsonPropertyName("cid")]
    public string Cid { get; set; } = "";

    [JsonPropertyName("authorName")]
    public string AuthorName { get; set; } = "";

    [JsonPropertyName("authorHandle")]
    public string AuthorHandle { get; set; } = "";

    [JsonPropertyName("authorAvatar")]
    public string? AuthorAvatar { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = "";

    [JsonPropertyName("createdAt")]
    public string CreatedAt { get; set; } = "";

    [JsonPropertyName("replyCount")]
    public int ReplyCount { get; set; }

    [JsonPropertyName("repostCount")]
    public int RepostCount { get; set; }

    [JsonPropertyName("likeCount")]
    public int LikeCount { get; set; }

    [JsonPropertyName("images")]
    public List<string> Images { get; set; } = new();
}


public class BlueskyConfig
{
    [JsonPropertyName("mode")]
    public string Mode { get; set; } = "author"; // "author" or "timeline"

    [JsonPropertyName("identifier")]
    public string Identifier { get; set; } = "bsky.app"; // handle or DID

    [JsonPropertyName("password")]
    public string Password { get; set; } = ""; // app password

    [JsonPropertyName("pdsUrl")]
    public string PdsUrl { get; set; } = "";

    [JsonPropertyName("pollIntervalSeconds")]
    public int PollIntervalSeconds { get; set; } = 60;

    [JsonPropertyName("displayDurationSeconds")]
    public int DisplayDurationSeconds { get; set; } = 12;
}

public class BlueskyService : IDisposable
{
    private readonly HttpClient _http;
    private readonly string _cacheDir;
    private readonly string _configFile;
    private readonly JsonSerializerOptions _jsonOpt = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };

    private readonly object _lock = new();
    private BlueskyConfig _config = new();
    private string? _accessJwt;
    private string? _refreshJwt;
    private string? _did;
    private string? _resolvedPds;

    private List<BlueskyPost> _cachedPosts = new();
    private DateTime _lastFetchTime = DateTime.MinValue;
    private string? _lastError;
    private bool _isFetching;

    public BlueskyConfig Config
    {
        get { lock (_lock) { return _config; } }
    }

    public string? LastError
    {
        get { lock (_lock) { return _lastError; } }
    }

    public DateTime LastFetchTime
    {
        get { lock (_lock) { return _lastFetchTime; } }
    }

    public BlueskyService()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var baseDir = Path.Combine(appData, "JizuraBluesky");
        _cacheDir = Path.Combine(baseDir, "cache");
        _configFile = Path.Combine(baseDir, "config.json");
        Directory.CreateDirectory(_cacheDir);

        _http = new HttpClient();
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("JIZURA-Bluesky-Bridge/1.0");

        LoadConfig();
    }

    private void LoadConfig()
    {
        try
        {
            if (File.Exists(_configFile))
            {
                var text = File.ReadAllText(_configFile);
                var loaded = JsonSerializer.Deserialize<BlueskyConfig>(text, _jsonOpt);
                if (loaded != null)
                {
                    _config = loaded;
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"設定ファイルの読み込みエラー: {ex.Message}");
        }
    }

    public void SaveConfig(BlueskyConfig newConfig)
    {
        lock (_lock)
        {
            _config = newConfig;
            // リセット
            _accessJwt = null;
            _refreshJwt = null;
            _resolvedPds = null;
        }

        try
        {
            var json = JsonSerializer.Serialize(newConfig, _jsonOpt);
            File.WriteAllText(_configFile, json);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"設定ファイルの保存エラー: {ex.Message}");
        }
    }

    public async Task RunBackgroundLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            int interval;
            lock (_lock)
            {
                interval = Math.Max(10, _config.PollIntervalSeconds);
            }

            try
            {
                await FetchTimelineAsync(ct);
            }
            catch (Exception ex)
            {
                lock (_lock)
                {
                    _lastError = ex.Message;
                }
                Console.Error.WriteLine($"タイムライン取得エラー: {ex.Message}");
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(interval), ct);
            }
            catch (TaskCanceledException)
            {
                break;
            }
        }
    }

    public async Task<List<BlueskyPost>> GetPostsAsync(bool forceRefresh, CancellationToken ct = default)
    {
        if (forceRefresh || _cachedPosts.Count == 0 || (DateTime.UtcNow - _lastFetchTime).TotalSeconds >= _config.PollIntervalSeconds)
        {
            await FetchTimelineAsync(ct);
        }

        lock (_lock)
        {
            return new List<BlueskyPost>(_cachedPosts);
        }
    }

    public async Task FetchTimelineAsync(CancellationToken ct = default)
    {
        lock (_lock)
        {
            if (_isFetching) return;
            _isFetching = true;
        }

        try
        {
            BlueskyConfig cfg;
            lock (_lock) { cfg = _config; }

            List<BlueskyPost> posts;
            if (cfg.Mode == "timeline" && !string.IsNullOrWhiteSpace(cfg.Identifier) && !string.IsNullOrWhiteSpace(cfg.Password))
            {
                posts = await FetchAuthenticatedTimelineAsync(cfg, ct);
            }
            else
            {
                posts = await FetchPublicAuthorFeedAsync(cfg.Identifier, ct);
            }

            lock (_lock)
            {
                _cachedPosts = posts;
                _lastFetchTime = DateTime.UtcNow;
                _lastError = null;
            }
        }
        catch (Exception ex)
        {
            lock (_lock)
            {
                _lastError = ex.Message;
            }
            throw;
        }
        finally
        {
            lock (_lock)
            {
                _isFetching = false;
            }
        }
    }

    private async Task<string> ResolveDidAsync(string handle, CancellationToken ct)
    {
        if (handle.StartsWith("did:")) return handle;
        var cleanHandle = handle.Trim().TrimStart('@');
        var url = $"https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle={Uri.EscapeDataString(cleanHandle)}";
        var res = await _http.GetStringAsync(url, ct);
        using var doc = JsonDocument.Parse(res);
        if (doc.RootElement.TryGetProperty("did", out var didEl))
        {
            return didEl.GetString() ?? throw new Exception("DIDの解決に失敗しました。");
        }
        throw new Exception("DIDが見つかりません。");
    }

    private async Task<string> ResolvePdsAsync(string did, CancellationToken ct)
    {
        var url = $"https://plc.directory/{Uri.EscapeDataString(did)}";
        var res = await _http.GetStringAsync(url, ct);
        using var doc = JsonDocument.Parse(res);
        if (doc.RootElement.TryGetProperty("service", out var services) && services.ValueKind == JsonValueKind.Array)
        {
            foreach (var s in services.EnumerateArray())
            {
                if (s.TryGetProperty("id", out var idEl) && idEl.GetString()?.EndsWith("#atproto_pds") == true)
                {
                    if (s.TryGetProperty("serviceEndpoint", out var epEl))
                    {
                        var ep = epEl.GetString();
                        if (!string.IsNullOrEmpty(ep)) return ep;
                    }
                }
            }
        }
        return "https://bsky.social";
    }

    private async Task EnsureSessionAsync(BlueskyConfig cfg, CancellationToken ct)
    {
        if (!string.IsNullOrEmpty(_accessJwt)) return;

        var cleanHandle = cfg.Identifier.Trim().TrimStart('@');
        var did = await ResolveDidAsync(cleanHandle, ct);
        _did = did;

        var pds = !string.IsNullOrWhiteSpace(cfg.PdsUrl) ? cfg.PdsUrl.TrimEnd('/') : await ResolvePdsAsync(did, ct);
        _resolvedPds = pds;

        var loginBody = JsonSerializer.Serialize(new
        {
            identifier = cleanHandle,
            password = cfg.Password
        });

        using var req = new HttpRequestMessage(HttpMethod.Post, $"{pds}/xrpc/com.atproto.server.createSession");
        req.Content = new StringContent(loginBody, Encoding.UTF8, "application/json");

        var resp = await _http.SendAsync(req, ct);
        var respText = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw new Exception($"ログイン失敗 ({resp.StatusCode}): {respText}");
        }

        using var doc = JsonDocument.Parse(respText);
        _accessJwt = doc.RootElement.GetProperty("accessJwt").GetString();
        _refreshJwt = doc.RootElement.GetProperty("refreshJwt").GetString();
    }

    private async Task<List<BlueskyPost>> FetchAuthenticatedTimelineAsync(BlueskyConfig cfg, CancellationToken ct)
    {
        await EnsureSessionAsync(cfg, ct);

        // getTimeline は PDS に問い合わせ、PDS が AppView にプロキシする
        var pds = _resolvedPds ?? "https://bsky.social";
        var timelineUrl = $"{pds}/xrpc/app.bsky.feed.getTimeline?limit=30";

        using var req = new HttpRequestMessage(HttpMethod.Get, timelineUrl);
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessJwt);

        var resp = await _http.SendAsync(req, ct);
        if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            // トークン期限切れ、再ログイン
            _accessJwt = null;
            await EnsureSessionAsync(cfg, ct);
            using var retryReq = new HttpRequestMessage(HttpMethod.Get, timelineUrl);
            retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _accessJwt);
            resp = await _http.SendAsync(retryReq, ct);
        }

        var json = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw new Exception($"タイムライン取得エラー ({resp.StatusCode}): {json}");
        }

        return ParseFeed(json);
    }

    private async Task<List<BlueskyPost>> FetchPublicAuthorFeedAsync(string identifier, CancellationToken ct)
    {
        var clean = string.IsNullOrWhiteSpace(identifier) ? "bsky.app" : identifier.Trim().TrimStart('@');
        var url = $"https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor={Uri.EscapeDataString(clean)}&limit=30";

        var resp = await _http.GetAsync(url, ct);
        var json = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw new Exception($"フィード取得エラー ({resp.StatusCode}): {json}");
        }

        return ParseFeed(json);
    }

    private static List<BlueskyPost> ParseFeed(string json)
    {
        var result = new List<BlueskyPost>();
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("feed", out var feedEl) || feedEl.ValueKind != JsonValueKind.Array)
        {
            return result;
        }

        foreach (var item in feedEl.EnumerateArray())
        {
            if (!item.TryGetProperty("post", out var postEl)) continue;

            var post = new BlueskyPost();
            if (postEl.TryGetProperty("uri", out var uriEl)) post.Uri = uriEl.GetString() ?? "";
            if (postEl.TryGetProperty("cid", out var cidEl)) post.Cid = cidEl.GetString() ?? "";

            if (postEl.TryGetProperty("author", out var authorEl))
            {
                if (authorEl.TryGetProperty("handle", out var hEl)) post.AuthorHandle = hEl.GetString() ?? "";
                if (authorEl.TryGetProperty("displayName", out var dEl)) post.AuthorName = dEl.GetString() ?? "";
                if (string.IsNullOrEmpty(post.AuthorName)) post.AuthorName = post.AuthorHandle;
                if (authorEl.TryGetProperty("avatar", out var aEl)) post.AuthorAvatar = aEl.GetString();
            }

            if (postEl.TryGetProperty("record", out var recEl))
            {
                if (recEl.TryGetProperty("text", out var tEl)) post.Text = tEl.GetString() ?? "";
                if (recEl.TryGetProperty("createdAt", out var cEl)) post.CreatedAt = cEl.GetString() ?? "";
            }

            if (postEl.TryGetProperty("replyCount", out var repEl) && repEl.TryGetInt32(out var rep)) post.ReplyCount = rep;
            if (postEl.TryGetProperty("repostCount", out var rpsEl) && rpsEl.TryGetInt32(out var rps)) post.RepostCount = rps;
            if (postEl.TryGetProperty("likeCount", out var lkEl) && lkEl.TryGetInt32(out var lk)) post.LikeCount = lk;

            // 添付画像 (embed.images または embed.media.images)
            if (postEl.TryGetProperty("embed", out var embEl))
            {
                ExtractImages(embEl, post.Images);
            }

            // フォールバック: record.embed
            if (post.Images.Count == 0 && recEl.ValueKind == JsonValueKind.Object && recEl.TryGetProperty("embed", out var recEmbEl))
            {
                string? did = null;
                if (authorEl.ValueKind == JsonValueKind.Object && authorEl.TryGetProperty("did", out var didEl))
                {
                    did = didEl.GetString();
                }

                if (!string.IsNullOrEmpty(did) && recEmbEl.TryGetProperty("images", out var rImgsEl) && rImgsEl.ValueKind == JsonValueKind.Array)
                {
                    foreach (var img in rImgsEl.EnumerateArray())
                    {
                        if (img.TryGetProperty("image", out var imgObj) && imgObj.TryGetProperty("ref", out var refObj) && refObj.TryGetProperty("$link", out var linkEl))
                        {
                            var blob = linkEl.GetString();
                            if (!string.IsNullOrEmpty(blob))
                            {
                                post.Images.Add($"https://cdn.bsky.app/img/feed_fullsize/plain/{did}/{blob}");
                            }
                        }
                    }
                }
            }


            // テキストが空でも絵がある場合は採用
            if (string.IsNullOrWhiteSpace(post.Text) && post.Images.Count > 0)
            {
                post.Text = $"{post.AuthorName} 🦋";
            }

            if (!string.IsNullOrWhiteSpace(post.Text))
            {
                result.Add(post);
            }
        }

        return result;
    }

    private static void ExtractImages(JsonElement embEl, List<string> images)
    {
        // 1. 直接の画像 (app.bsky.embed.images#view)
        if (embEl.TryGetProperty("images", out var imgsEl) && imgsEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var img in imgsEl.EnumerateArray())
            {
                string? url = null;
                if (img.TryGetProperty("fullsize", out var fEl)) url = fEl.GetString();
                if (string.IsNullOrEmpty(url) && img.TryGetProperty("thumb", out var tEl)) url = tEl.GetString();
                if (!string.IsNullOrEmpty(url)) images.Add(url);
            }
        }
        // 2. 引用＋メディア (app.bsky.embed.recordWithMedia#view)
        else if (embEl.TryGetProperty("media", out var mediaEl))
        {
            ExtractImages(mediaEl, images);
        }
        // 3. 外部カードのサムネイル画像フォールバック
        else if (embEl.TryGetProperty("external", out var extEl))
        {
            if (extEl.TryGetProperty("thumb", out var thumbEl))
            {
                var thumb = thumbEl.GetString();
                if (!string.IsNullOrEmpty(thumb)) images.Add(thumb);
            }
        }
    }


    public async Task<(byte[] bytes, string contentType)> GetCachedAvatarAsync(string avatarUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(avatarUrl))
        {
            return (Array.Empty<byte>(), "application/octet-stream");
        }

        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(avatarUrl)));
        var ext = Path.GetExtension(new Uri(avatarUrl).AbsolutePath);
        if (string.IsNullOrEmpty(ext)) ext = ".jpg";
        var cachePath = Path.Combine(_cacheDir, hash + ext);
        var metaPath = Path.Combine(_cacheDir, hash + ".meta");

        if (File.Exists(cachePath) && File.Exists(metaPath))
        {
            var cachedBytes = await File.ReadAllBytesAsync(cachePath, ct);
            var ctType = await File.ReadAllTextAsync(metaPath, ct);
            return (cachedBytes, ctType.Trim());
        }

        var resp = await _http.GetAsync(avatarUrl, ct);
        if (!resp.IsSuccessStatusCode)
        {
            throw new Exception($"画像の取得に失敗しました: {resp.StatusCode}");
        }

        var downloadedBytes = await resp.Content.ReadAsByteArrayAsync(ct);
        var contentType = resp.Content.Headers.ContentType?.MediaType ?? "image/jpeg";

        await File.WriteAllBytesAsync(cachePath, downloadedBytes, ct);
        await File.WriteAllTextAsync(metaPath, contentType, ct);

        return (downloadedBytes, contentType);
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
