using System.Buffers;
using System.Text.Json;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Protocol;
using PoMiniGames.Shared.Games;
using PoMiniGamesClient.Features.PoRacer;

namespace PoMiniGames.Unit.Features.PoRacer;

public sealed class PoRacerHubProtocolTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SnapshotFastPathPreservesTheStandardProtocolAndFraming(bool segmented)
    {
        if (segmented) PartialAndSegmentedFramesPreserveFramingAndAdjacentMessages();
        else SnapshotPassesThroughAsBytesWhileOtherMessagesUseTheStandardProtocol();
    }

    private static void SnapshotPassesThroughAsBytesWhileOtherMessagesUseTheStandardProtocol()
    {
        var json = new JsonHubProtocol();
        var protocol = new PoRacerHubProtocol(json);
        var binder = new Binder();
        var snapshot = new PoRacerRaceSnapshot
        {
            GameCode = "solo-test",
            Cars = [new() { Id = 1, X = 12.345, Surface = "sand" }],
        };
        var original = json.GetMessageBytes(new InvocationMessage("raceSnapshot", [snapshot])).ToArray();
        var input = new ReadOnlySequence<byte>(original);
        Assert.True(protocol.TryParseMessage(ref input, binder, out var message));
        var invocation = Assert.IsType<InvocationMessage>(message);
        Assert.Equal("raceSnapshot", invocation.Target);
        Assert.Equal(original[..^1], Assert.IsType<byte[]>(Assert.Single(invocation.Arguments)));
        Assert.True(input.IsEmpty);

        foreach (var other in new HubMessage[]
        {
            PingMessage.Instance,
            CompletionMessage.WithResult("join", "joined"),
            new InvocationMessage("raceRoster", new object[] { new List<PoRacerCarInfo>() }),
        })
        {
            input = new ReadOnlySequence<byte>(json.GetMessageBytes(other));
            Assert.True(protocol.TryParseMessage(ref input, binder, out message));
            Assert.Equal(other.GetType(), Assert.IsAssignableFrom<HubMessage>(message).GetType());
            Assert.True(input.IsEmpty);
        }
        Assert.Equal(json.GetMessageBytes(new InvocationMessage("SendInput", [new PoRacerInput { Up = true }])).ToArray(),
            protocol.GetMessageBytes(new InvocationMessage("SendInput", [new PoRacerInput { Up = true }])).ToArray());
    }

    private static void PartialAndSegmentedFramesPreserveFramingAndAdjacentMessages()
    {
        var json = new JsonHubProtocol();
        var protocol = new PoRacerHubProtocol(json);
        var binder = new Binder();
        var frame = json.GetMessageBytes(new InvocationMessage("raceSnapshot",
            [new PoRacerRaceSnapshot { GameCode = "UTF8-赛车" }])).ToArray();
        var input = new ReadOnlySequence<byte>(frame[..^1]);
        var length = input.Length;
        Assert.False(protocol.TryParseMessage(ref input, binder, out _));
        Assert.Equal(length, input.Length);

        var first = new Segment(frame.AsMemory(0, 10));
        var last = first.Append(frame.AsMemory(10));
        input = new ReadOnlySequence<byte>(first, 0, last, last.Memory.Length);
        Assert.True(protocol.TryParseMessage(ref input, binder, out var message));
        var bytes = Assert.IsType<byte[]>(Assert.Single(Assert.IsType<InvocationMessage>(message).Arguments));
        using var parsed = JsonDocument.Parse(bytes);
        Assert.Equal("UTF8-赛车", parsed.RootElement.GetProperty("arguments")[0].GetProperty("gameCode").GetString());
        Assert.Equal(frame[..^1], bytes);
        Assert.True(input.IsEmpty);

        input = new ReadOnlySequence<byte>(frame.Concat(json.GetMessageBytes(PingMessage.Instance).ToArray()).ToArray());
        Assert.True(protocol.TryParseMessage(ref input, binder, out message));
        Assert.IsType<InvocationMessage>(message);
        Assert.True(protocol.TryParseMessage(ref input, binder, out message));
        Assert.IsType<PingMessage>(message);
        Assert.True(input.IsEmpty);
    }

    private sealed class Binder : IInvocationBinder
    {
        public Type GetReturnType(string invocationId) => typeof(string);
        public IReadOnlyList<Type> GetParameterTypes(string methodName) =>
            methodName == "raceRoster" ? [typeof(List<PoRacerCarInfo>)] : [typeof(byte[])];
        public Type GetStreamItemType(string streamId) => typeof(string);
    }

    private sealed class Segment : ReadOnlySequenceSegment<byte>
    {
        public Segment(ReadOnlyMemory<byte> memory) => Memory = memory;

        public Segment Append(ReadOnlyMemory<byte> memory)
        {
            var next = new Segment(memory) { RunningIndex = RunningIndex + Memory.Length };
            Next = next;
            return next;
        }
    }
}
