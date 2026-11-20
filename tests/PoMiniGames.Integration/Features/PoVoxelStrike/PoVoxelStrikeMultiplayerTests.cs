using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PoMiniGames.Features.PoVoxelStrike;
using PoMiniGames.Shared.Games;

namespace PoMiniGames.Integration;

/// <summary>
/// Co-op lifecycle smoke for PoVoxelStrike. Exercises the in-memory services the
/// SignalR hubs delegate to (lobby join/ready/start, lockstep session allocation,
/// input batching, frame drain, end-of-run teardown) without a live hub. Lives in
/// the Integration tier — the Unit tier is at its 100-method ceiling.
/// </summary>
public sealed class PoVoxelStrikeMultiplayerTests
{
    /// <summary>
    /// Full co-op lifecycle: 2 players join, both ready, host starts, the lockstep
    /// session allocates with the lobby's player roster, both submit inputs at the
    /// platform's 20 Hz cadence, the pump drains a frame, and end-of-run tears the
    /// session down cleanly.
    /// </summary>
    [DockerFact]
    public void Lobby_Ready_Start_Lockstep_Pump_End_CleanLifecycle()
    {
        var lobby = new PoVoxelStrikeLobbyService();
        var lockstep = new PoVoxelStrikeLockstepService(NullLogger<PoVoxelStrikeLockstepService>.Instance);

        // Two players arrive. Lobby is single global (matches PoRacer/PoFunQuiz).
        var (host, _) = lobby.Open("conn-host", "Alice", isGuest: false);
        host.Players.Should().HaveCount(1);
        host.HostConnectionId.Should().Be("conn-host");
        host.MaxPlayers.Should().Be(6);

        var (withPeer, _) = lobby.Open("conn-peer", "Bob", isGuest: true);
        withPeer.Players.Should().HaveCount(2);
        withPeer.Players[0].PlayerNumber.Should().Be(1, "first arrival is always seat 1");
        withPeer.Players[1].PlayerNumber.Should().Be(2);

        // Seats are stable across re-join — Bob disconnects and reconnects, his seat stays put.
        lobby.Leave("conn-peer");
        var (rejoined, _) = lobby.Open("conn-peer", "Bob", isGuest: true);
        rejoined.Players.Single(p => p.ConnectionId == "conn-peer").PlayerNumber.Should().Be(2);

        // Both ready (host auto-readies; non-host must toggle). Without all ready the host
        // cannot start the run.
        lobby.TryStart("conn-host").Should().BeFalse("peer has not toggled ready");
        var (toggledOk, toggledReady, _) = lobby.ToggleReady("conn-peer");
        toggledOk.Should().BeTrue();
        toggledReady.Should().BeTrue();
        lobby.TryStart("conn-host").Should().BeTrue();

        // Lockstep session allocates with the lobby's captured player list. Seats
        // 1..N in stable order — important for the PlayerNumber→batch ordering contract
        // that clients rely on for input dispatch.
        var session = lockstep.GetOrCreateSession(PoVoxelStrikeLobbyService.GlobalCode, lobby.Players);
        session.Players.Should().HaveCount(2);
        session.Players[0].PlayerNumber.Should().Be(1);
        session.Players[1].PlayerNumber.Should().Be(2);

        // Bind connections so the service can route inputs to the right session.
        lockstep.BindConnection("conn-host", PoVoxelStrikeLobbyService.GlobalCode);
        lockstep.BindConnection("conn-peer", PoVoxelStrikeLobbyService.GlobalCode);

        // Each player submits inputs at the 20 Hz cadence.
        session.SubmitInput(new PoVoxelStrikeInputBatch
        {
            ConnectionId = "conn-host",
            PlayerNumber = 1,
            Tick = 1,
            Inputs = { new() { Forward = true, Yaw = 12f, Pitch = -10f } },
        });
        session.SubmitInput(new PoVoxelStrikeInputBatch
        {
            ConnectionId = "conn-peer",
            PlayerNumber = 2,
            Tick = 1,
            Inputs = { new() { Right = true, Fire = true, Yaw = -8f, Pitch = 0f } },
        });

        // First drain emits one frame with both peers' batches in PlayerNumber order.
        var frame = session.DrainFrame();
        frame.Should().NotBeNull();
        frame!.Tick.Should().Be(1);
        frame.Batches.Should().HaveCount(2);
        frame.Batches[0].PlayerNumber.Should().Be(1);
        frame.Batches[1].PlayerNumber.Should().Be(2);
        frame.Batches[0].Inputs[0].Forward.Should().BeTrue();
        frame.Batches[1].Inputs[0].Right.Should().BeTrue();

        // Second drain with no inputs returns null — the hub must not broadcast an empty frame.
        session.DrainFrame().Should().BeNull();

        // Host ends the run; the session tears down and the lobby clears its started flag.
        lockstep.EndRun(PoVoxelStrikeLobbyService.GlobalCode);
        lobby.End();
        lockstep.GetByConnection("conn-host").Should().BeNull("session torn down on EndRun");
        lockstep.Sessions.Should().BeEmpty();
        lobby.IsStarted.Should().BeFalse();
    }
}
