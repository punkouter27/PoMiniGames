namespace PoMiniGames.Shared.Dtos;

/// <summary>A single trivia question returned by /api/funquiz/quiz/questions.</summary>
public class QuizQuestion
{
    public string Text { get; set; } = string.Empty;
    public List<string> Options { get; set; } = [];
    public int CorrectOptionIndex { get; set; }
    public string Category { get; set; } = "General";
    public int BasePoints { get; set; } = 2;
}
