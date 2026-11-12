using System.Buffers;
using System.Diagnostics.CodeAnalysis;
using Microsoft.AspNetCore.Connections;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Protocol;

namespace PoMiniGamesClient.Features.PoRacer;

/// <summary>
/// Pass the server's standard JSON race broadcasts to native JS without parsing
/// thousands of car fields in WASM. All other SignalR traffic uses the normal protocol.
/// </summary>
public sealed class PoRacerHubProtocol(IHubProtocol inner) : IHubProtocol
{
    private static ReadOnlySpan<byte> SnapshotPrefix => "{\"type\":1,\"target\":\"raceSnapshot\",\"arguments\":["u8;
    public string Name => inner.Name;
    public int Version => inner.Version;
    public TransferFormat TransferFormat => inner.TransferFormat;
    public bool IsVersionSupported(int version) => inner.IsVersionSupported(version);
    public ReadOnlyMemory<byte> GetMessageBytes(HubMessage message) => inner.GetMessageBytes(message);
    public void WriteMessage(HubMessage message, IBufferWriter<byte> output) => inner.WriteMessage(message, output);

    public bool TryParseMessage(ref ReadOnlySequence<byte> input, IInvocationBinder binder,
        [NotNullWhen(true)] out HubMessage? message)
    {
        var reader = new SequenceReader<byte>(input);
        if (reader.TryReadTo(out ReadOnlySequence<byte> payload, (byte)0x1e)
            && payload.Length >= SnapshotPrefix.Length)
        {
            Span<byte> prefix = stackalloc byte[SnapshotPrefix.Length];
            payload.Slice(0, prefix.Length).CopyTo(prefix);
            if (prefix.SequenceEqual(SnapshotPrefix))
            {
                message = new InvocationMessage("raceSnapshot", [payload.ToArray()]);
                input = reader.UnreadSequence;
                return true;
            }
        }
        return inner.TryParseMessage(ref input, binder, out message);
    }
}
