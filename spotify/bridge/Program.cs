using System.Diagnostics;
using System.Net;
using System.Text;
using System.Text.Json;
using JizuraSpotify;

// JIZURA spotify-view bridge: reads what Spotify (Windows app) is playing and serves
//   /             spotify/www (the viewer page)
//   /jizura.js    the JIZURA engine, concatenated from src/*.js on request (always matches the repo)
//   /api/now      { found, title, artist, album, duration, position, playing, rate }
//   /api/lyrics   LRCLIB synced lyrics (?title&artist&album&duration[&refresh=1]), cached on disk
// usage: JizuraSpotify [--port 8790] [--root <JIZURA folder>] [--no-browser]

var port = 8790;
string? root = null;
var openBrowser = true;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--port" && i + 1 < args.Length && int.TryParse(args[i + 1], out var p)) { port = p; i++; }
    else if (args[i] == "--root" && i + 1 < args.Length) { root = args[++i]; }
    else if (args[i] == "--no-browser") openBrowser = false;
}
root ??= FindRoot(AppContext.BaseDirectory) ?? FindRoot(Environment.CurrentDirectory);
if (root is null) { Console.Error.WriteLine("JIZURA のフォルダー（src/ と spotify/www/ がある場所）が見つかりません。--root で指定してください。"); return 1; }
var www = Path.Combine(root, "spotify", "www");
var src = Path.Combine(root, "src");

using var cts = new CancellationTokenSource();
Console.CancelKeyPress += (_, e) => { e.Cancel = true; cts.Cancel(); };
var now = new NowPlaying();
_ = now.RunAsync(cts.Token);
using var lyrics = new LyricsService();

var listener = new HttpListener();
var prefix = $"http://localhost:{port}/";
listener.Prefixes.Add(prefix);
try { listener.Start(); }
catch (HttpListenerException ex) { Console.Error.WriteLine($"ポート {port} を開けません: {ex.Message}（--port で変更できます）"); return 1; }
Console.WriteLine($"JIZURA spotify-view: {prefix}");
Console.WriteLine($"  root: {root}");
Console.WriteLine("  Windows 版 Spotify で曲を再生してください。終了は Ctrl+C。");
if (openBrowser) { try { Process.Start(new ProcessStartInfo(prefix) { UseShellExecute = true }); } catch { /* no browser: open the URL by hand */ } }
cts.Token.Register(() => { try { listener.Stop(); } catch { } });

var json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
string? engine = null; DateTime engineStamp = default;
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
    var req = ctx.Request; var res = ctx.Response;
    try
    {
        res.Headers["Cache-Control"] = "no-store";
        var path = req.Url?.AbsolutePath ?? "/";
        if (path == "/api/now")
        {
            var s = now.Snapshot();
            await Send(res, 200, "application/json", JsonSerializer.Serialize(new
            {
                s.Found, s.Title, s.Artist, s.Album, s.Duration, s.Position, s.Playing, s.Rate, error = now.LastError,
            }, json));
        }
        else if (path == "/api/lyrics")
        {
            var q = req.QueryString;
            double.TryParse(q["duration"], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var duration);
            try
            {
                var r = await lyrics.GetAsync(q["title"] ?? "", q["artist"] ?? "", q["album"] ?? "", duration, q["refresh"] == "1", cts.Token);
                await Send(res, 200, "application/json", JsonSerializer.Serialize(new { found = r is not null, synced = r?.SyncedLyrics, plain = r?.PlainLyrics, instrumental = r?.Instrumental ?? false }, json));
            }
            catch (Exception ex)
            {
                var msg = ex.Message.Contains("503") || ex.Message.Contains("ServerOverloaded")
                    ? "LRCLIB サーバーが一時的に混み合っています。少し待って「歌詞を再取得」を押してください。"
                    : ex.Message;
                await Send(res, 200, "application/json", JsonSerializer.Serialize(new { found = false, error = msg }, json));
            }
        }
        else if (path == "/jizura.js")
        {
            await Send(res, 200, "text/javascript; charset=utf-8", Engine());
        }
        else
        {
            var name = path == "/" ? "index.html" : path.TrimStart('/');
            var file = Path.GetFullPath(Path.Combine(www, name));
            if (!file.StartsWith(Path.GetFullPath(www) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
            { await Send(res, 404, "text/plain; charset=utf-8", "not found"); return; }
            var type = Path.GetExtension(file).ToLowerInvariant() switch
            {
                ".html" => "text/html; charset=utf-8", ".js" => "text/javascript; charset=utf-8", ".css" => "text/css; charset=utf-8",
                ".svg" => "image/svg+xml", ".png" => "image/png", _ => "application/octet-stream",
            };
            res.ContentType = type;
            var bytes = await File.ReadAllBytesAsync(file);
            res.StatusCode = 200; res.ContentLength64 = bytes.Length;
            await res.OutputStream.WriteAsync(bytes);
        }
    }
    catch (Exception ex)
    {
        try { await Send(res, 500, "text/plain; charset=utf-8", ex.Message); } catch { }
    }
    finally { try { res.Close(); } catch { } }
}

// the engine = every src/*.js in name order (what build.py puts in index.html, minus the editor UI which
// switches itself off when there is no #app element); rebuilt when a source file changes
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

static async Task Send(HttpListenerResponse res, int status, string type, string body)
{
    var bytes = Encoding.UTF8.GetBytes(body);
    res.StatusCode = status; res.ContentType = type; res.ContentLength64 = bytes.Length;
    await res.OutputStream.WriteAsync(bytes);
}

static string? FindRoot(string start)
{
    for (var d = new DirectoryInfo(start); d is not null; d = d.Parent)
        if (File.Exists(Path.Combine(d.FullName, "src", "01_util.js")) && Directory.Exists(Path.Combine(d.FullName, "spotify", "www"))) return d.FullName;
    return null;
}
