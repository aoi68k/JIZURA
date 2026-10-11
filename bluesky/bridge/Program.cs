using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using JizuraBluesky;

// JIZURA bluesky-view bridge: fetches Bluesky timeline every 60s and serves
//   /                    bluesky/www (viewer)
//   /jizura.js           the JIZURA engine, concatenated from src/*.js on request
//   /api/timeline        timeline posts (?refresh=1 to force refresh)
//   /api/config          GET/POST configuration
//   /api/status          health status, last fetch time, error
//   /api/proxy-image     cached proxy for avatar images (?url=...)
// usage: JizuraBluesky [--port 8791] [--root <JIZURA folder>] [--no-browser]

var port = 8791;
string? root = null;
var openBrowser = true;

for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p)) { port = p; i++; }
    else if (args[i] == "--root" && i + 1 < args.Length) { root = args[++i]; }
    else if (args[i] == "--no-browser") openBrowser = false;
}

root ??= FindRoot(AppContext.BaseDirectory) ?? FindRoot(Environment.CurrentDirectory);
if (root is null)
{
    Console.Error.WriteLine("JIZURA のフォルダー（src/ と bluesky/www/ がある場所）が見つかりません。--root で指定してください。");
    return 1;
}

var www = Path.Combine(root, "bluesky", "www");
var src = Path.Combine(root, "src");

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };

using var bluesky = new BlueskyService();
_ = bluesky.RunBackgroundLoopAsync(cts.Token);

var listener = new HttpListener();
var prefix = $"http://localhost:{port}/";
listener.Prefixes.Add(prefix);

try { listener.Start(); }
catch (HttpListenerException ex)
{
    Console.Error.WriteLine($"ポート {port} を開けません: {ex.Message}（--port で変更できます）");
    return 1;
}

Console.WriteLine($"JIZURA bluesky-view: {prefix}");
Console.WriteLine($"  root: {root}");
Console.WriteLine($"  Bluesky タイムラインを {bluesky.Config.PollIntervalSeconds} 秒ごとに確認します。終了は Ctrl+C。");

if (openBrowser)
{
    try { Process.Start(new ProcessStartInfo(prefix) { UseShellExecute = true }); }
    catch { /* 手動でURLを開く */ }
}

cts.Token.Register(() => { try { listener.Stop(); } catch { } });

var jsonOpt = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
string? engine = null;
DateTime engineStamp = default;
var engineGate = new object();

while (!cts.IsCancellationRequested)
{
    HttpListenerContext ctx;
    try { ctx = await listener.GetContextAsync(); }
    catch (Exception) when (cts.IsCancellationRequested) { break; }
    catch (HttpListenerException) { break; }
    _ = Task.Run(() => HandleAsync(ctx));
}

return 0;

async Task HandleAsync(HttpListenerContext ctx)
{
    var req = ctx.Request;
    var res = ctx.Response;

    try
    {
        res.Headers["Cache-Control"] = "no-store";
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";

        if (req.HttpMethod == "OPTIONS")
        {
            res.StatusCode = 204;
            res.Close();
            return;
        }

        var path = req.Url?.AbsolutePath ?? "/";
        var method = req.HttpMethod;

        if (path == "/api/timeline")
        {
            var q = req.QueryString;
            var forceRefresh = q["refresh"] == "1";
            try
            {
                var posts = await bluesky.GetPostsAsync(forceRefresh, cts.Token);
                await SendJson(res, 200, new
                {
                    posts,
                    lastFetchTime = bluesky.LastFetchTime,
                    pollIntervalSeconds = bluesky.Config.PollIntervalSeconds,
                    displayDurationSeconds = bluesky.Config.DisplayDurationSeconds,
                    error = bluesky.LastError
                }, method);
            }
            catch (Exception ex)
            {
                await SendJson(res, 502, new { error = ex.Message }, method);
            }
        }
        else if (path == "/api/config")
        {
            if (req.HttpMethod == "POST")
            {
                using var reader = new StreamReader(req.InputStream, req.ContentEncoding);
                var body = await reader.ReadToEndAsync();
                var newCfg = JsonSerializer.Deserialize<BlueskyConfig>(body, jsonOpt);
                if (newCfg != null)
                {
                    bluesky.SaveConfig(newCfg);
                    // 設定保存直後に更新を試みる
                    _ = Task.Run(async () =>
                    {
                        try { await bluesky.FetchTimelineAsync(cts.Token); } catch { }
                    });
                    await SendJson(res, 200, new { success = true, config = bluesky.Config }, method);
                }
                else
                {
                    await SendJson(res, 400, new { error = "無効な設定データです" }, method);
                }
            }
            else
            {
                var cfg = bluesky.Config;
                // パスワードはマスクして返す
                var safeCfg = new
                {
                    cfg.Mode,
                    cfg.Identifier,
                    hasPassword = !string.IsNullOrEmpty(cfg.Password),
                    cfg.PdsUrl,
                    cfg.PollIntervalSeconds,
                    cfg.DisplayDurationSeconds
                };
                await SendJson(res, 200, safeCfg, method);
            }
        }
        else if (path == "/api/status")
        {
            await SendJson(res, 200, new
            {
                lastFetchTime = bluesky.LastFetchTime,
                error = bluesky.LastError,
                pollIntervalSeconds = bluesky.Config.PollIntervalSeconds,
                mode = bluesky.Config.Mode,
                identifier = bluesky.Config.Identifier
            }, method);
        }
        else if (path == "/api/proxy-image")
        {
            var imgUrl = req.QueryString["url"];
            if (string.IsNullOrWhiteSpace(imgUrl))
            {
                await SendText(res, 400, "text/plain", "url query required", method);
                return;
            }

            try
            {
                var (bytes, contentType) = await bluesky.GetCachedAvatarAsync(imgUrl, cts.Token);
                res.Headers["Cache-Control"] = "public, max-age=86400";
                res.ContentType = contentType;
                res.StatusCode = 200;
                res.ContentLength64 = bytes.Length;
                if (method != "HEAD")
                {
                    await res.OutputStream.WriteAsync(bytes);
                }
            }
            catch (Exception ex)
            {
                await SendText(res, 502, "text/plain", ex.Message, method);
            }
        }
        else if (path == "/jizura.js")
        {
            await SendText(res, 200, "text/javascript; charset=utf-8", Engine(), method);
        }
        else
        {
            var name = path == "/" ? "index.html" : path.TrimStart('/');
            var file = Path.GetFullPath(Path.Combine(www, name));
            if (!file.StartsWith(Path.GetFullPath(www) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
            {
                await SendText(res, 404, "text/plain; charset=utf-8", "not found", method);
                return;
            }

            var type = Path.GetExtension(file).ToLowerInvariant() switch
            {
                ".html" => "text/html; charset=utf-8",
                ".js" => "text/javascript; charset=utf-8",
                ".css" => "text/css; charset=utf-8",
                ".svg" => "image/svg+xml",
                ".png" => "image/png",
                ".webp" => "image/webp",
                _ => "application/octet-stream",
            };

            res.ContentType = type;
            var bytes = await File.ReadAllBytesAsync(file);
            res.StatusCode = 200;
            res.ContentLength64 = bytes.Length;
            if (method != "HEAD")
            {
                await res.OutputStream.WriteAsync(bytes);
            }
        }
    }
    catch (Exception ex)
    {
        try { await SendText(res, 500, "text/plain; charset=utf-8", ex.Message); } catch { }
    }
    finally
    {
        try { res.Close(); } catch { }
    }
}

string Engine()
{
    var files = Directory.GetFiles(src, "*.js").OrderBy(f => Path.GetFileName(f), StringComparer.Ordinal).ToArray();
    var stamp = files.Select(File.GetLastWriteTimeUtc).DefaultIfEmpty().Max();
    lock (engineGate)
    {
        if (engine is not null && stamp == engineStamp) return engine;
        var version = File.Exists(Path.Combine(root, "VERSION")) ? File.ReadAllText(Path.Combine(root, "VERSION")).Trim() : "dev";
        engine = string.Join("\n", files.Select(File.ReadAllText)).Replace("@VERSION@", version);
        engineStamp = stamp;
        return engine;
    }
}

static async Task SendJson(HttpListenerResponse res, int status, object data, string method = "GET")
{
    var json = JsonSerializer.Serialize(data, new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase });
    var bytes = Encoding.UTF8.GetBytes(json);
    res.StatusCode = status;
    res.ContentType = "application/json; charset=utf-8";
    res.ContentLength64 = bytes.Length;
    if (method != "HEAD")
    {
        await res.OutputStream.WriteAsync(bytes);
    }
}

static async Task SendText(HttpListenerResponse res, int status, string type, string body, string method = "GET")
{
    var bytes = Encoding.UTF8.GetBytes(body);
    res.StatusCode = status;
    res.ContentType = type;
    res.ContentLength64 = bytes.Length;
    if (method != "HEAD")
    {
        await res.OutputStream.WriteAsync(bytes);
    }
}

static string? FindRoot(string start)
{
    for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
    {
        if (File.Exists(Path.Combine(d.FullName, "src", "01_util.js")) && Directory.Exists(Path.Combine(d.FullName, "bluesky", "www")))
        {
            return d.FullName;
        }
    }
    return null;
}

