using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

const int Port = 9333;
var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
var configPath = Path.Combine(home, ".raw", "edge-bridge.json");
if (!File.Exists(configPath)) return 2;
var config = JsonNode.Parse(await File.ReadAllTextAsync(configPath))?.AsObject();
var token = config?["token"]?.GetValue<string>();
if (string.IsNullOrWhiteSpace(token)) return 2;

// Reloading the extension starts a fresh host while the previous instance can
// still be holding the port. The new one then fails to bind, the old one has
// no extension attached any more, and every later request times out with no
// hint as to why. Only one bridge can serve the port, so retire earlier
// instances, but only when a browser launched us through native messaging,
// since running the executable by hand must not take down a working bridge.
if (Console.IsInputRedirected)
{
    foreach (var stale in System.Diagnostics.Process.GetProcessesByName("raw-edge-bridge"))
    {
        if (stale.Id == Environment.ProcessId) continue;
        try { stale.Kill(); stale.WaitForExit(2000); } catch { /* already gone */ }
    }
}

// A retired instance releases the listening socket asynchronously. Binding too
// early throws, and the browser is then left with a host that died on startup,
// so wait for the port instead of racing the process that just let it go.
await WaitForPortAsync(Port, TimeSpan.FromSeconds(5));

var native = new NativeChannel(Console.OpenStandardInput(), Console.OpenStandardOutput());
var builder = WebApplication.CreateSlimBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseUrls($"http://127.0.0.1:{Port}");
var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(20) });

bool Authorized(HttpContext context) =>
    context.Request.Headers["X-Raw-Bridge-Token"] == token || context.Request.Query["token"] == token;

app.MapGet("/json/version", (HttpContext context) => {
    if (!Authorized(context)) return Results.Unauthorized();
    return Results.Json(new JsonObject {
        ["Browser"] = "RawEdgeBridge/0.2",
        ["Protocol-Version"] = "1.3",
        ["Raw-Extension-Version"] = native.ExtensionVersion,
        ["webSocketDebuggerUrl"] = $"ws://127.0.0.1:{Port}/devtools/browser/raw-edge?token={Uri.EscapeDataString(token)}",
    });
});

app.MapGet("/json/list", async (HttpContext context) => {
    if (!Authorized(context)) return Results.Unauthorized();
    var result = await native.RequestAsync("listTabs", new JsonObject());
    var targets = new JsonArray();
    foreach (var tab in result?.AsArray() ?? []) {
        if (tab is null) continue;
        var id = tab["id"]?.GetValue<string>() ?? "";
        targets.Add(new JsonObject {
            ["id"] = id,
            ["type"] = "page",
            ["title"] = tab["title"]?.DeepClone(),
            ["url"] = tab["url"]?.DeepClone(),
            ["active"] = tab["active"]?.DeepClone(),
            ["windowId"] = tab["windowId"]?.DeepClone(),
            ["webSocketDebuggerUrl"] = $"ws://127.0.0.1:{Port}/devtools/page/{id}?token={Uri.EscapeDataString(token)}",
        });
    }
    return Results.Json(targets);
});

app.MapMethods("/json/new", ["GET", "PUT"], async (HttpContext context) => {
    if (!Authorized(context)) return Results.Unauthorized();
    var raw = context.Request.QueryString.Value?.TrimStart('?') ?? "about%3Ablank";
    var url = Uri.UnescapeDataString(raw);
    var active = !string.Equals(context.Request.Headers["X-Raw-Tab-Active"], "0", StringComparison.Ordinal);
    var tab = await native.RequestAsync("createTab", new JsonObject { ["url"] = url, ["active"] = active });
    var id = tab?["id"]?.GetValue<string>() ?? throw new InvalidOperationException("extension returned no tab id");
    return Results.Json(new {
        id,
        type = "page",
        title = tab?["title"]?.GetValue<string>() ?? "",
        url = tab?["url"]?.GetValue<string>() ?? url,
        webSocketDebuggerUrl = $"ws://127.0.0.1:{Port}/devtools/page/{id}?token={Uri.EscapeDataString(token)}",
    });
});

app.MapMethods("/json/close/{tabId}", ["GET", "PUT"], async (HttpContext context, string tabId) => {
    if (!Authorized(context)) return Results.Unauthorized();
    await native.RequestAsync("closeTab", new JsonObject { ["tabId"] = tabId });
    return Results.Text("Target is closing");
});

app.MapMethods("/json/activate/{tabId}", ["GET", "PUT"], async (HttpContext context, string tabId) => {
    if (!Authorized(context)) return Results.Unauthorized();
    await native.RequestAsync("activateTab", new JsonObject { ["tabId"] = tabId });
    return Results.Text("Target activated");
});

app.MapMethods("/json/restore", ["POST", "PUT"], async (HttpContext context) => {
    if (!Authorized(context)) return Results.Unauthorized();
    var result = await native.RequestAsync("restoreClosedTab", new JsonObject());
    return Results.Json(result);
});

app.Map("/devtools/page/{tabId}", async (HttpContext context, string tabId) => {
    if (!Authorized(context)) { context.Response.StatusCode = 401; return; }
    if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var connection = native.AddPageSocket(tabId, socket);
    try { await PumpPageSocket(socket, connection, tabId, native); }
    finally { native.RemovePageSocket(connection); }
});

app.Map("/devtools/browser/raw-edge", async (HttpContext context) => {
    if (!Authorized(context)) { context.Response.StatusCode = 401; return; }
    if (!context.WebSockets.IsWebSocketRequest) { context.Response.StatusCode = 400; return; }
    using var socket = await context.WebSockets.AcceptWebSocketAsync();
    var connection = native.AddBrowserSocket(socket);
    try { await PumpBrowserSocket(socket, connection, native); }
    finally { native.RemoveBrowserSocket(connection); }
});

var readTask = Task.Run(async () => {
    try { await native.ReadLoopAsync(); }
    finally { app.Lifetime.StopApplication(); }
});
await app.RunAsync();
await readTask;
return 0;

static async Task PumpPageSocket(WebSocket socket, Guid connection, string tabId, NativeChannel native) {
    while (socket.State == WebSocketState.Open) {
        var message = await ReceiveJson(socket);
        if (message is null) break;
        var id = message["id"]?.DeepClone();
        var method = message["method"]?.GetValue<string>();
        if (id is null || string.IsNullOrEmpty(method)) continue;
        try {
            var parameters = message["params"]?.DeepClone() ?? new JsonObject();
            var result = method.StartsWith("Target.", StringComparison.Ordinal) ||
                method.StartsWith("Browser.", StringComparison.Ordinal)
                ? await native.BrowserRequestAsync(method, parameters, tabId: tabId)
                : await native.RequestAsync("cdp", new JsonObject {
                    ["tabId"] = tabId,
                    ["method"] = method,
                    ["params"] = parameters,
                });
            await native.SendPageAsync(connection, new JsonObject { ["id"] = id, ["result"] = result?.DeepClone() ?? new JsonObject() });
        } catch (Exception error) {
            await native.SendPageAsync(connection, ErrorReply(id, error.Message));
        }
    }
}

static async Task PumpBrowserSocket(WebSocket socket, Guid connection, NativeChannel native) {
    while (socket.State == WebSocketState.Open) {
        var message = await ReceiveJson(socket);
        if (message is null) break;
        var id = message["id"]?.DeepClone();
        var method = message["method"]?.GetValue<string>();
        if (id is null || string.IsNullOrEmpty(method)) continue;
        try {
            var sessionId = message["sessionId"]?.GetValue<string>();
            var payload = new JsonObject {
                ["method"] = method,
                ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
            };
            if (!string.IsNullOrEmpty(sessionId)) payload["sessionId"] = sessionId;
            var result = string.IsNullOrEmpty(sessionId)
                ? await native.BrowserRequestAsync(method, payload["params"]?.DeepClone() ?? new JsonObject())
                : await native.RequestAsync("cdp", payload);
            result ??= new JsonObject();
            await native.SendBrowserAsync(connection, new JsonObject { ["id"] = id, ["result"] = result });
        } catch (Exception error) {
            await native.SendBrowserAsync(connection, ErrorReply(id, error.Message));
        }
    }
}

static JsonObject ErrorReply(JsonNode id, string message) => new() {
    ["id"] = id,
    ["error"] = new JsonObject { ["code"] = -32000, ["message"] = message },
};

static async Task<bool> WaitForPortAsync(int port, TimeSpan timeout) {
    var deadline = DateTime.UtcNow + timeout;
    while (true) {
        var probe = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, port);
        try {
            probe.Start();
            probe.Stop();
            return true;
        } catch (System.Net.Sockets.SocketException) {
            if (DateTime.UtcNow >= deadline) return false;
            await Task.Delay(150);
        }
    }
}

static async Task<JsonObject?> ReceiveJson(WebSocket socket) {
    using var stream = new MemoryStream();
    var buffer = new byte[64 * 1024];
    while (true) {
        var read = await socket.ReceiveAsync(buffer, CancellationToken.None);
        if (read.MessageType == WebSocketMessageType.Close) return null;
        stream.Write(buffer, 0, read.Count);
        if (stream.Length > 64 * 1024 * 1024) throw new InvalidOperationException("bridge message exceeded 64 MB");
        if (read.EndOfMessage) break;
    }
    return JsonNode.Parse(stream.ToArray())?.AsObject();
}

sealed class SocketRegistration(string? tabId, WebSocket socket) {
    public string? TabId { get; } = tabId;
    public WebSocket Socket { get; } = socket;
    public SemaphoreSlim SendLock { get; } = new(1, 1);
}

sealed class NativeChannel(Stream input, Stream output) {
    readonly ConcurrentDictionary<string, TaskCompletionSource<JsonNode?>> pending = new();
    readonly ConcurrentDictionary<Guid, SocketRegistration> pageSockets = new();
    readonly ConcurrentDictionary<Guid, SocketRegistration> browserSockets = new();
    readonly SemaphoreSlim outputLock = new(1, 1);
    public string? ExtensionVersion { get; private set; }

    public Guid AddPageSocket(string tabId, WebSocket socket) {
        var id = Guid.NewGuid();
        pageSockets[id] = new SocketRegistration(tabId, socket);
        return id;
    }
    public void RemovePageSocket(Guid id) => pageSockets.TryRemove(id, out _);
    public Guid AddBrowserSocket(WebSocket socket) {
        var id = Guid.NewGuid();
        browserSockets[id] = new SocketRegistration(null, socket);
        return id;
    }
    public void RemoveBrowserSocket(Guid id) => browserSockets.TryRemove(id, out _);
    public Task SendPageAsync(Guid id, JsonNode message) => SendRegistered(pageSockets, id, message);
    public Task SendBrowserAsync(Guid id, JsonNode message) => SendRegistered(browserSockets, id, message);

    static async Task SendRegistered(ConcurrentDictionary<Guid, SocketRegistration> sockets, Guid id, JsonNode message) {
        if (!sockets.TryGetValue(id, out var registration) || registration.Socket.State != WebSocketState.Open) return;
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await registration.SendLock.WaitAsync();
        try { await registration.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
        finally { registration.SendLock.Release(); }
    }

    public async Task<JsonNode?> RequestAsync(string op, JsonObject payload) {
        var requestId = Guid.NewGuid().ToString("N");
        var completion = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
        pending[requestId] = completion;
        await SendNativeAsync(new JsonObject {
            ["kind"] = "request", ["requestId"] = requestId, ["op"] = op, ["payload"] = payload,
        });
        try { return await completion.Task.WaitAsync(TimeSpan.FromSeconds(30)); }
        finally { pending.TryRemove(requestId, out _); }
    }

    public async Task<JsonNode?> BrowserRequestAsync(string method, JsonNode parameters, string? tabId = null) {
        var payload = new JsonObject {
            ["method"] = method,
            ["params"] = parameters.DeepClone(),
        };
        if (!string.IsNullOrEmpty(tabId)) payload["tabId"] = tabId;
        try {
            return await RequestAsync("browserCdp", payload);
        } catch (InvalidOperationException error) when (error.Message.Contains("unsupported bridge operation: browserCdp", StringComparison.Ordinal)) {
            return await LegacyBrowserRequestAsync(method, parameters, tabId);
        }
    }

    async Task<JsonNode?> LegacyBrowserRequestAsync(string method, JsonNode parameters, string? tabId) {
        var args = parameters.AsObject();
        switch (method) {
            case "Target.createTarget": {
                var tab = await RequestAsync("createTab", new JsonObject {
                    ["url"] = args["url"]?.GetValue<string>() ?? "about:blank",
                    ["active"] = args["background"]?.GetValue<bool>() != true,
                });
                return new JsonObject { ["targetId"] = tab?["id"]?.DeepClone() };
            }
            case "Target.closeTarget":
                await RequestAsync("closeTab", new JsonObject { ["tabId"] = args["targetId"]?.DeepClone() ?? tabId });
                return new JsonObject { ["success"] = true };
            case "Target.activateTarget":
                await RequestAsync("activateTab", new JsonObject { ["tabId"] = args["targetId"]?.DeepClone() ?? tabId });
                return new JsonObject();
            case "Target.attachToTarget": {
                var targetId = args["targetId"]?.GetValue<string>() ?? tabId ?? throw new InvalidOperationException("Target.attachToTarget requires targetId");
                return new JsonObject { ["sessionId"] = $"raw-edge-tab-{targetId}" };
            }
            case "Target.detachFromTarget":
            case "Target.setDiscoverTargets":
            case "Target.setAutoAttach":
            case "Target.setRemoteLocations":
            case "Target.disposeBrowserContext":
            case "Browser.setDownloadBehavior":
                return new JsonObject();
            case "Target.getBrowserContexts":
                return new JsonObject { ["browserContextIds"] = new JsonArray() };
            case "Target.createBrowserContext":
                throw new InvalidOperationException("isolated browser contexts are unavailable in Edge extension mode");
            case "Browser.getVersion":
                return new JsonObject { ["product"] = "RawEdgeBridge/legacy-extension", ["protocolVersion"] = "1.3" };
            case "Target.getTargets": {
                var tabs = await RequestAsync("listTabs", new JsonObject());
                var infos = new JsonArray();
                foreach (var tab in tabs?.AsArray() ?? []) {
                    if (tab is null) continue;
                    infos.Add(new JsonObject {
                        ["targetId"] = tab["id"]?.DeepClone(),
                        ["type"] = "page",
                        ["title"] = tab["title"]?.DeepClone(),
                        ["url"] = tab["url"]?.DeepClone(),
                        ["attached"] = false,
                    });
                }
                return new JsonObject { ["targetInfos"] = infos };
            }
            case "Target.getTargetInfo": {
                var wanted = args["targetId"]?.GetValue<string>() ?? tabId;
                var tabs = await RequestAsync("listTabs", new JsonObject());
                var tab = tabs?.AsArray().FirstOrDefault(item => item?["id"]?.GetValue<string>() == wanted)
                    ?? throw new InvalidOperationException($"No tab with id: {wanted}");
                return new JsonObject { ["targetInfo"] = new JsonObject {
                    ["targetId"] = tab["id"]?.DeepClone(),
                    ["type"] = "page",
                    ["title"] = tab["title"]?.DeepClone(),
                    ["url"] = tab["url"]?.DeepClone(),
                    ["attached"] = false,
                } };
            }
            default: {
                var selected = tabId;
                if (string.IsNullOrEmpty(selected)) {
                    var tabs = await RequestAsync("listTabs", new JsonObject());
                    selected = tabs?.AsArray().FirstOrDefault(tab => tab?["active"]?.GetValue<bool>() == true)?["id"]?.GetValue<string>()
                        ?? tabs?.AsArray().FirstOrDefault()?["id"]?.GetValue<string>();
                }
                if (string.IsNullOrEmpty(selected)) throw new InvalidOperationException("Edge has no tab target available for this CDP command");
                return await RequestAsync("cdp", new JsonObject {
                    ["tabId"] = selected,
                    ["method"] = method,
                    ["params"] = parameters.DeepClone(),
                });
            }
        }
    }

    public async Task ReadLoopAsync() {
        var sizeBytes = new byte[4];
        while (await ReadExactlyOrEof(input, sizeBytes)) {
            var length = BitConverter.ToInt32(sizeBytes, 0);
            if (length <= 0 || length > 64 * 1024 * 1024) throw new InvalidOperationException("invalid native message length");
            var payload = new byte[length];
            if (!await ReadExactlyOrEof(input, payload)) break;
            var message = JsonNode.Parse(payload)?.AsObject();
            if (message is null) continue;
            var kind = message["kind"]?.GetValue<string>();
            if (kind == "hello") {
                ExtensionVersion = message["version"]?.GetValue<string>();
            } else if (kind == "response") {
                var requestId = message["requestId"]?.GetValue<string>();
                if (requestId is not null && pending.TryRemove(requestId, out var completion)) {
                    if (message["ok"]?.GetValue<bool>() == true) completion.TrySetResult(message["result"]?.DeepClone());
                    else completion.TrySetException(new InvalidOperationException(message["error"]?.GetValue<string>() ?? "Edge extension request failed"));
                }
            } else if (kind == "event") {
                var tabId = message["tabId"]?.ToString();
                if (tabId is not null) await Broadcast(pageSockets.Values.Where(s => s.TabId == tabId), new JsonObject {
                    ["method"] = message["method"]?.DeepClone(), ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                });
            } else if (kind == "browserEvent") {
                await Broadcast(browserSockets.Values, new JsonObject {
                    ["method"] = message["method"]?.DeepClone(), ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                });
            } else if (kind == "browserSessionEvent") {
                await Broadcast(browserSockets.Values, new JsonObject {
                    ["sessionId"] = message["sessionId"]?.DeepClone(),
                    ["method"] = message["method"]?.DeepClone(),
                    ["params"] = message["params"]?.DeepClone() ?? new JsonObject(),
                });
            }
        }
    }

    async Task Broadcast(IEnumerable<SocketRegistration> registrations, JsonNode message) {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        foreach (var registration in registrations.ToArray()) {
            if (registration.Socket.State != WebSocketState.Open) continue;
            await registration.SendLock.WaitAsync();
            try { await registration.Socket.SendAsync(bytes, WebSocketMessageType.Text, true, CancellationToken.None); }
            catch { /* the websocket handler removes stale registrations */ }
            finally { registration.SendLock.Release(); }
        }
    }

    async Task SendNativeAsync(JsonNode value) {
        var payload = Encoding.UTF8.GetBytes(value.ToJsonString());
        var size = BitConverter.GetBytes(payload.Length);
        await outputLock.WaitAsync();
        try {
            await output.WriteAsync(size);
            await output.WriteAsync(payload);
            await output.FlushAsync();
        } finally { outputLock.Release(); }
    }

    static async Task<bool> ReadExactlyOrEof(Stream stream, byte[] buffer) {
        var offset = 0;
        while (offset < buffer.Length) {
            var count = await stream.ReadAsync(buffer.AsMemory(offset));
            if (count == 0) return false;
            offset += count;
        }
        return true;
    }
}
