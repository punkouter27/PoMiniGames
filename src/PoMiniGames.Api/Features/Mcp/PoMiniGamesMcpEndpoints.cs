using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using PoMiniGames.Features.Health;
using PoMiniGames.Infrastructure;

namespace PoMiniGames.Features.Mcp;

/// <summary>
/// Read-only Model Context Protocol (MCP) Streamable HTTP endpoint (<c>/mcp</c>).
/// Implements JSON-RPC 2.0 (<c>initialize</c>, <c>tools/list</c>, <c>tools/call</c>) so AI assistants
/// can query live system status, game catalog, and shareable challenge links without secrets.
/// </summary>
public static class PoMiniGamesMcpEndpoints
{
    private static readonly string[] Games =
    [
        "connectfive", "tictactoe", "pobrawl", "pocabinet", "pocapitol", "pocouplequiz",
        "poecosystem", "pofighter", "pofunquiz", "pomarblerace", "pomule", "poracer",
        "povoxelstrike", "sand-playground",
    ];

    public static IEndpointRouteBuilder MapPoMiniGamesMcpEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/mcp", () => Results.Json(new
        {
            protocolVersion = "2025-03-26",
            serverInfo = new { name = "PoMiniGames", version = PoPlatform.Version },
            capabilities = new { tools = new { listChanged = false } },
        }))
        .WithTags("MCP")
        .WithName("GetMcpServerInfo")
        .AllowAnonymous();

        app.MapPost("/mcp", HandleRpcAsync)
            .WithTags("MCP")
            .WithName("PostMcpRpc")
            .AllowAnonymous();

        return app;
    }

    private static async Task<IResult> HandleRpcAsync(HttpContext http, HealthSnapshotCache healthCache, CancellationToken ct)
    {
        JsonNode? root;
        try
        {
            root = await JsonNode.ParseAsync(http.Request.Body, cancellationToken: ct);
        }
        catch (JsonException)
        {
            return RpcError(null, -32700, "Parse error");
        }

        if (root is not JsonObject req)
            return RpcError(null, -32600, "Invalid Request");

        var id = req["id"]?.DeepClone();
        var method = req["method"]?.GetValue<string>() ?? "";

        return method switch
        {
            "initialize" => RpcOk(id, new JsonObject
            {
                ["protocolVersion"] = "2025-03-26",
                ["serverInfo"] = new JsonObject { ["name"] = "PoMiniGames", ["version"] = PoPlatform.Version },
                ["capabilities"] = new JsonObject { ["tools"] = new JsonObject { ["listChanged"] = false } },
            }),
            "notifications/initialized" => Results.NoContent(),
            "tools/list" => RpcOk(id, new JsonObject
            {
                ["tools"] = new JsonArray
                {
                    ToolDef("list_games", "List all fourteen instant-play games and their routes on PoMiniGames.", new JsonObject()),
                    ToolDef("get_system_status", "Read the anonymous /api/diag health summary (API, Data, Services).", new JsonObject()),
                    ToolDef("create_challenge_link", "Build a shareable play/demo URL for a PoMiniGames game.", new JsonObject
                    {
                        ["game"] = new JsonObject { ["type"] = "string", ["description"] = "Game slug (e.g. pobrawl, pomarblerace, poecosystem)" },
                        ["seed"] = new JsonObject { ["type"] = "string", ["description"] = "Optional deterministic seed" },
                    }),
                },
            }),
            "tools/call" => await CallToolAsync(id, req["params"] as JsonObject, http, healthCache, ct),
            _ => RpcError(id, -32601, $"Method not found: {method}"),
        };
    }

    private static async Task<IResult> CallToolAsync(
        JsonNode? id, JsonObject? parameters, HttpContext http, HealthSnapshotCache healthCache, CancellationToken ct)
    {
        var name = parameters?["name"]?.GetValue<string>() ?? "";
        var args = parameters?["arguments"] as JsonObject;

        switch (name)
        {
            case "list_games":
                var catalog = new JsonArray(Games.Select(g => (JsonNode)new JsonObject { ["id"] = g, ["route"] = $"/{g}" }).ToArray());
                return ToolResult(id, catalog.ToJsonString());

            case "get_system_status":
                var cached = healthCache.Peek();
                var summary = cached is null
                    ? new JsonObject { ["status"] = "Unknown", ["version"] = PoPlatform.Version, ["note"] = "Call GET /api/diag to warm snapshot." }
                    : new JsonObject
                    {
                        ["status"] = cached.Diag.Status,
                        ["environment"] = cached.Diag.Environment,
                        ["version"] = cached.Diag.Version,
                        ["checkedAt"] = cached.Diag.CheckedAt.ToString("O"),
                        ["checks"] = cached.Diag.Checks.Length,
                    };
                return ToolResult(id, summary.ToJsonString());

            case "create_challenge_link":
                var game = (args?["game"]?.GetValue<string>() ?? "pobrawl").Trim().ToLowerInvariant();
                if (!Games.Contains(game, StringComparer.Ordinal))
                    return ToolResult(id, $"Unknown game '{game}'. Valid games: {string.Join(", ", Games)}", isError: true);
                var seed = args?["seed"]?.GetValue<string>();
                var origin = $"{http.Request.Scheme}://{http.Request.Host}";
                var url = string.IsNullOrWhiteSpace(seed)
                    ? $"{origin}/{game}"
                    : $"{origin}/{game}?seed={Uri.EscapeDataString(seed.Trim())}";
                return ToolResult(id, url);

            default:
                return RpcError(id, -32602, $"Unknown tool: {name}");
        }
    }

    private static JsonObject ToolDef(string name, string description, JsonObject properties) => new()
    {
        ["name"] = name,
        ["description"] = description,
        ["inputSchema"] = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = properties,
        },
    };

    private static IResult ToolResult(JsonNode? id, string text, bool isError = false) => RpcOk(id, new JsonObject
    {
        ["content"] = new JsonArray { new JsonObject { ["type"] = "text", ["text"] = text } },
        ["isError"] = isError,
    });

    private static IResult RpcOk(JsonNode? id, JsonNode result) => Results.Json(new JsonObject
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id,
        ["result"] = result,
    });

    private static IResult RpcError(JsonNode? id, int code, string message) => Results.Json(new JsonObject
    {
        ["jsonrpc"] = "2.0",
        ["id"] = id,
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message },
    });
}
