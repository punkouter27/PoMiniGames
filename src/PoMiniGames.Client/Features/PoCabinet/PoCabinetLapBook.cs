using System.Text.Json;

namespace PoMiniGamesClient.Features.PoCabinet;

/// <summary>
/// One race's lap and sector book for the local car: the splits race.js reports
/// (<see cref="Sector"/>), the laps the snapshots close (<see cref="CloseLap"/>), this race's bests
/// and the stored personal bests (records.js) they are compared with. The HUD, the pause card and
/// the results table all read it. A new race starts a new book.
/// </summary>
public sealed class PoCabinetLapBook
{
    private readonly double[] _sessionBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];
    private readonly double[] _storedBestSectors = [double.MaxValue, double.MaxValue, double.MaxValue];

    /// <summary>The lap in progress's splits (null = not crossed yet).</summary>
    public double?[] SectorTimes { get; private set; } = new double?[3];
    /// <summary>Each finished lap's three splits, in lap order.</summary>
    public List<double?[]> LapSectors { get; } = new();
    public List<double> LapTimes { get; } = new();
    /// <summary>Per entry of <see cref="LapTimes"/>: deleted for track limits.</summary>
    public List<bool> LapDeleted { get; } = new();
    /// <summary>The sector being driven (0..2) and the race time it began at.</summary>
    public int SectorIndex { get; private set; }
    public double SectorStart { get; private set; }
    public double LastLapSeconds { get; private set; }
    /// <summary>Race time the last lap closed at: the next lap is timed from it.</summary>
    public double LastLapEnd { get; private set; }
    /// <summary>This race's best lap that counted (0 = none yet).</summary>
    public double BestLapSession { get; private set; }
    public double StoredBestLap { get; private set; }

    /// <summary>This race's best lap, or the stored one before the first lap is done.</summary>
    public double BestLapShown => BestLapSession > 0 ? BestLapSession : StoredBestLap;

    public int LapRows => Math.Max(LapTimes.Count, LapSectors.Count);

    /// <summary>The fastest lap that counted (the laps table marks its row).</summary>
    public double BestValidLap => LapTimes.Where((t, i) => t > 0 && !(i < LapDeleted.Count && LapDeleted[i])).DefaultIfEmpty(0).Min();

    /// <summary>The stored personal bests, from records.js <c>getRecords</c>.</summary>
    public void LoadStored(JsonElement rec)
    {
        if (rec.ValueKind != JsonValueKind.Object) return;
        if (rec.TryGetProperty("bestLap", out var bl) && bl.ValueKind == JsonValueKind.Number && bl.GetDouble() is var lap and > 0)
            StoredBestLap = lap;
        if (rec.TryGetProperty("sectors", out var secs) && secs.ValueKind == JsonValueKind.Array)
        {
            var i = 0;
            foreach (var s in secs.EnumerateArray())
            {
                if (i >= 3) break;
                if (s.ValueKind == JsonValueKind.Number && s.GetDouble() is var v and > 0) _storedBestSectors[i] = v;
                i++;
            }
        }
    }

    /// <summary>
    /// race.js: the local car crossed sector boundary <paramref name="sector"/> (0..2, thirds of
    /// the lap) at race time <paramref name="raceTime"/>, <paramref name="seconds"/> after the
    /// previous one. Sector 2 closing is the lap line: the lap's splits join the table.
    /// </summary>
    public bool Sector(int sector, double seconds, double raceTime)
    {
        if (sector is < 0 or > 2 || !(seconds > 0)) return false;
        SectorTimes[sector] = seconds;
        if (seconds < _sessionBestSectors[sector]) _sessionBestSectors[sector] = seconds;
        SectorStart = raceTime;
        SectorIndex = (sector + 1) % 3;
        if (sector == 2)
        {
            LapSectors.Add((double?[])SectorTimes.Clone());
            SectorTimes = new double?[3];
        }
        return true;
    }

    /// <summary>A lap closed at race time <paramref name="elapsed"/>; a deleted one is timed but never a best.</summary>
    public void CloseLap(double lapTime, double elapsed, bool deleted)
    {
        if (lapTime > 0)
        {
            LastLapSeconds = lapTime;
            LapTimes.Add(lapTime);
            LapDeleted.Add(deleted);
            if (!deleted && (BestLapSession <= 0 || lapTime < BestLapSession)) BestLapSession = lapTime;
        }
        LastLapEnd = elapsed;
    }

    /// <summary>A best lap race.js or the server timed (it can beat the snapshots' own timing by a tick).</summary>
    public void ReportBest(double seconds)
    {
        if (seconds > 0 && (BestLapSession <= 0 || seconds < BestLapSession)) BestLapSession = seconds;
    }

    /// <summary>Green for a personal-best split, violet for this race's best.</summary>
    public string SectorClass(double? t, int index)
    {
        if (t is null || index < 0 || index > 2) return "";
        if (t.Value <= _storedBestSectors[index]) return "pocabinet-sector--pb";
        if (t.Value <= _sessionBestSectors[index]) return "pocabinet-sector--session";
        return "";
    }

    /// <summary>This race's best splits for records.js (0 = none).</summary>
    public double[] BestSectors() =>
        _sessionBestSectors.Select(s => s < 3600 ? Math.Round(s, 2) : 0).ToArray();
}
