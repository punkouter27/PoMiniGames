using System.Text.Json.Serialization;

namespace PoMiniGamesClient.Features.PoBrawl;

public sealed class FfaDashboard
{
    public int Season { get; set; } = 1;
    public int Completed { get; set; }
    public int TotalRounds { get; set; }
    public int SeasonRounds { get; set; } = 20;
    public string Profile { get; set; } = "balanced";
    public string ActiveProfile { get; set; } = "balanced";
    public bool Writable { get; set; } = true;
    public bool BenchmarkRunning { get; set; }
    public bool FactsEnabled { get; set; }
    public List<FfaRecord> Records { get; set; } = [];
    public List<FfaSeasonTitle> History { get; set; } = [];
    public FfaBenchmark? Benchmark { get; set; }
    public List<FfaAgent> Agents { get; set; } = [];
    public FfaAgentEvaluation? AgentEvaluation { get; set; }
}

public sealed class FfaAgent
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string Preset { get; set; } = "native";
    public List<string> Presets { get; set; } = [];
}

public sealed class FfaAgentEvaluation
{
    public string CharacterId { get; set; } = "";
    public string CandidatePreset { get; set; } = "";
    public string IncumbentPreset { get; set; } = "";
    public string Status { get; set; } = "";
    public int Rounds { get; set; }
    public bool Promoted { get; set; }
    public double PlacementGain { get; set; }
    public FfaEvaluationPair AveragePlace { get; set; } = new();
}

public sealed class FfaEvaluationPair
{
    public double Candidate { get; set; }
    public double Incumbent { get; set; }
}

public sealed class FfaRecord
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public double Rating { get; set; } = 1000;
    public int Rounds { get; set; }
    public int Wins { get; set; }
    public int Places { get; set; }
    public int Damage { get; set; }
    public int Knockouts { get; set; }
    public int RearHitsTaken { get; set; }
    public int SeasonPoints { get; set; }
    public double AveragePlace => Rounds > 0 ? (double)Places / Rounds : 0;
}

public sealed class FfaSeasonTitle
{
    public int Season { get; set; }
    public string Champion { get; set; } = "";
    public int Points { get; set; }
}

public sealed class FfaBenchmark
{
    public int Completed { get; set; }
    public int Total { get; set; }
    public List<FfaBenchmarkRow> Rows { get; set; } = [];
}

public sealed class FfaBenchmarkRow
{
    public string Profile { get; set; } = "";
    public int Rounds { get; set; }
    public int Wins { get; set; }
    public double AveragePlace { get; set; }
    public double AverageDamage { get; set; }
    public int Knockouts { get; set; }
    public double PlacementGain { get; set; }
}

public sealed class FfaBroadcast
{
    public string Focus { get; set; } = "";
    public string Attacker { get; set; } = "";
    public int Health { get; set; }
    public string Shot { get; set; } = "Overview";
    public bool FinalDuel { get; set; }
    public bool Overtime { get; set; }
    public List<FfaElimination> Feed { get; set; } = [];
}

public sealed class FfaElimination
{
    public string Id { get; set; } = "";
    public string Attacker { get; set; } = "";
    public int Place { get; set; }
}

public sealed class FfaPresentation
{
    public FfaRecording Recording { get; set; } = new();
    public FfaFact Fact { get; set; } = new();
}

public sealed class FfaRecording
{
    public bool Supported { get; set; }
    public bool Enabled { get; set; }
    public string Status { get; set; } = "Checking recording support";
    public List<FfaClip> Clips { get; set; } = [];
}

public sealed class FfaClip
{
    public int Id { get; set; }
    public string Label { get; set; } = "";
    public string Url { get; set; } = "";
    public string MimeType { get; set; } = "";
}

public sealed class FfaFact
{
    public string Status { get; set; } = "Facts are off";
    public string? Text { get; set; }
    public string? SourceUrl { get; set; }
    public string Name { get; set; } = "";
}

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase)]
[JsonSerializable(typeof(FfaDashboard))]
[JsonSerializable(typeof(FfaBroadcast))]
[JsonSerializable(typeof(FfaPresentation))]
internal sealed partial class PoBrawlFfaJsonContext : JsonSerializerContext;
