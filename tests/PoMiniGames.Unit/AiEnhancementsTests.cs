using PoMiniGames.Features.PoRacer;
using PoMiniGames.Shared.Games;
using PoMiniGames.Shared.Games.PoMule;
using PoMiniGamesClient.Features.BoardAi;
using Xunit;

namespace PoMiniGames.Unit;

public sealed class AiEnhancementsTests
{
    [Fact]
    public void PidDifficultyDirector_AdaptsSmoothlyAndRespectsBounds()
    {
        var director = new PidDifficultyDirector(initialSkill: 0.5, minSkill: 0.2, maxSkill: 0.9);

        var start = director.SkillLevel;
        for (int i = 0; i < 20; i++)
        {
            director.Update(0.95, 1.0);
        }
        Assert.True(director.SkillLevel > start);
        Assert.InRange(director.SkillLevel, 0.2, 0.9);

        var highSkill = director.SkillLevel;
        for (int i = 0; i < 30; i++)
        {
            director.Update(0.10, 1.0);
        }
        Assert.True(director.SkillLevel < highSkill);
        Assert.InRange(director.SkillLevel, 0.2, 0.9);

        var profile = director.CurrentProfile();
        Assert.InRange(profile.ReactionDelayScale, 0.5, 1.5);
        Assert.InRange(profile.FeintRate, 0.0, 0.6);
        Assert.InRange(profile.MistakeRate, 0.0, 0.4);
    }

    [Fact]
    public void PoMuleGoapPlanner_ChainsPrerequisitesBeforeMining()
    {
        var match = MatchState.New(seed: 42, humanSpecies: Species.Humanoid);
        var facts = PoMuleGoapPlanner.WorldFacts.HasEmptyPlot | PoMuleGoapPlanner.WorldFacts.HasCashForMule;

        var seq = PoMuleGoapPlanner.PlanGoodSequence(match, seat: 1, Objective.MineSmithore, facts);

        Assert.NotEmpty(seq);
        Assert.Equal(Good.Energy, seq[0]);
        Assert.Contains(Good.Food, seq);
        Assert.Contains(Good.Smithore, seq);
    }

    [Fact]
    public void GridMcts_WithRaveAndNeuralPriorHook_FindsImmediateWinningMove()
    {
        var geom = new GridGeometry(6, 7, 4, gravity: true, seed: 12345);
        var cells = new byte[geom.Total];
        // Player 1 has three in a row at bottom (row 5, cols 1,2,3) -> col 4 (cell 39) or col 0 (cell 35) wins.
        cells[5 * 7 + 1] = 1;
        cells[5 * 7 + 2] = 1;
        cells[5 * 7 + 3] = 1;
        var pos = GridPosition.FromCells(geom, cells, toMove: 1);

        var mcts = new GridMcts(geom, new Random(7))
        {
            PriorEvaluator = _ =>
            {
                var priors = new double[geom.Total];
                Array.Fill(priors, 1.0 / geom.Total);
                priors[5 * 7 + 4] = 0.5;
                return (priors, 0.8);
            }
        };

        var result = mcts.Run(pos, budgetMs: 30, maxIterations: 200);
        Assert.True(result.Move == 5 * 7 + 4 || result.Move == 5 * 7 + 0);
        Assert.True(result.Iterations > 0);
    }

    [Fact]
    public void PoRacerAiDriver_PlanTacticalLane_DefendsInsideWhenRivalClosing()
    {
        ReadOnlySpan<double> rightBend = [0.02, 0.02, 0.015, 0.01, 0.0];
        double lane = PoRacerAiDriver.PlanTacticalLane(
            currentLateral: 0.0,
            halfWidth: 40.0,
            upcomingCurvatures: rightBend,
            slipstreamLateral: 0.0,
            hasSlipstreamTarget: false,
            defenderLateral: -18.0,
            rivalClosingBehind: true,
            aggression: 0.8);

        Assert.True(lane < 0.0);
        Assert.InRange(lane, -32.0, 32.0);
    }
}
