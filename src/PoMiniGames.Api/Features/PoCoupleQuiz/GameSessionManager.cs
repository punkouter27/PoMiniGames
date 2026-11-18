namespace PoMiniGames.Features.PoCoupleQuiz;

/// <summary>
/// In-memory holder of the one live PoCoupleQuiz match: a <see cref="GameSession"/> plus the
/// connection-to-player map so the SignalR hub can identify a caller by connection id.
/// </summary>
/// <remarks>
/// <para>Pairing is the lobby's job (<see cref="CoupleQuizLobbyHub"/>). When its host starts, the
/// lobby calls <see cref="Reserve"/>, which opens the session under an internal code and the two
/// seat names; each player then claims their seat with <see cref="JoinMatch"/> on the game hub,
/// and the match begins when both have. One match at a time, as there always was: a second
/// <see cref="Reserve"/> is refused while one is live.</para>
/// <para>Pattern: Singleton + Active-Record. The session is mutated in place; this class is
/// the only writer. A plain lock guards it: the interesting operations (join, record answer,
/// advance) are multi-field.</para>
/// <para>Locking is deliberately coarse: every operation here is a handful of list/set
/// mutations with no I/O. The question draws that DO take time happen in
/// <see cref="CoupleQuizRoundDirector"/>, outside this lock.</para>
/// </remarks>
public sealed class GameSessionManager
{
    /// <summary>How long a reservation nobody claimed blocks the next one.</summary>
    public static readonly TimeSpan ReservationLifetime = TimeSpan.FromSeconds(45);

    private readonly Lock _gate = new();
    private GameSession? _session;

    /// <summary>The current match, or null when there is none.</summary>
    public GameSession? Current
    {
        get { lock (_gate) { return _session; } }
    }

    /// <summary>
    /// Open the match for the lobby's seats (host first) and return its internal code, or null
    /// when another match is live or still waiting on its players.
    /// </summary>
    public string? Reserve(IReadOnlyList<string> names, int rounds, string topicPack)
    {
        lock (_gate)
        {
            if (_session is { } live && live.State != SessionState.Finished
                && (live.State == SessionState.InProgress || DateTime.UtcNow - live.ReservedAtUtc < ReservationLifetime))
            {
                return null;
            }
            _session?.DisarmTimer();
            _session = new GameSession
            {
                MatchCode = "match-" + Guid.NewGuid().ToString("N"),
                ExpectedNames = [.. names],
                MaxRounds = Game.AllowedRounds.Contains(rounds) ? rounds : Game.DefaultRounds,
                TopicPack = CoupleQuizExternalPackService.IsValidPack(topicPack)
                    ? CoupleQuizExternalPackService.NormalizePack(topicPack)
                    : "Classic",
                State = SessionState.Waiting,
            };
            return _session.MatchCode;
        }
    }

    /// <summary>
    /// Claim the reserved seat named <paramref name="playerName"/> in the match
    /// <paramref name="matchCode"/>. Returns null when the code is stale, the name is not a
    /// reserved seat, or that seat is taken. <c>AllSeated</c> is true when the last seat is claimed.
    /// </summary>
    public (GameSession Session, bool AllSeated)? JoinMatch(string connectionId, string matchCode, string playerName)
    {
        lock (_gate)
        {
            if (_session is null || _session.State != SessionState.Waiting
                || !string.Equals(_session.MatchCode, matchCode, StringComparison.Ordinal))
            {
                return null;
            }
            var name = _session.ExpectedNames.FirstOrDefault(n => string.Equals(n, playerName, StringComparison.Ordinal));
            if (name is null || _session.Players.Any(p => p.Name == name || p.ConnectionId == connectionId)) return null;
            _session.Players.Add(new LobbyPlayer(name, connectionId));
            // Seat order is the lobby's: the host sits first and is the King of round 0.
            _session.Players.Sort((x, y) =>
                _session.ExpectedNames.IndexOf(x.Name).CompareTo(_session.ExpectedNames.IndexOf(y.Name)));
            return (_session, _session.Players.Count == _session.ExpectedNames.Count);
        }
    }

    /// <summary>Drop a player. Returns the session (null if the caller wasn't in one).</summary>
    public GameSession? RemovePlayer(string connectionId, out bool sessionEmpty)
    {
        sessionEmpty = false;
        lock (_gate)
        {
            if (_session is null) return null;
            if (_session.Players.All(p => p.ConnectionId != connectionId)) return null;

            var session = _session;
            session.Players.RemoveAll(p => p.ConnectionId == connectionId);

            if (session.Players.Count == 0)
            {
                session.DisarmTimer();
                _session = null;
                sessionEmpty = true;
                return session;
            }

            // A player leaving mid-match also leaves the Game's roster, or the round can
            // never complete: AllPlayersAnswered waits on a name nobody will submit, and
            // the rotating King seat could land on an empty chair.
            session.ActiveGame?.Players.RemoveAll(
                p => session.Players.All(lp => lp.Name != p.Name));

            return session;
        }
    }

    public GameSession? GetSessionByConnection(string connectionId)
    {
        lock (_gate)
        {
            return _session is not null && _session.Players.Any(p => p.ConnectionId == connectionId)
                ? _session
                : null;
        }
    }

    /// <summary>
    /// Snapshot of asked question texts for the current session (clears history when starting a match).
    /// </summary>
    public (string TopicPack, HashSet<string> Asked) PrepareQuestionDraw(bool newMatch)
    {
        lock (_gate)
        {
            if (_session is null) return ("Classic", new HashSet<string>(StringComparer.Ordinal));
            if (newMatch) _session.AskedQuestions.Clear();
            return (_session.TopicPack, new HashSet<string>(_session.AskedQuestions, StringComparer.Ordinal));
        }
    }

    public void RecordAskedQuestion(string text)
    {
        lock (_gate)
        {
            _session?.AskedQuestions.Add(text);
        }
    }

    /// <summary>
    /// A curated question this match has not asked yet. <paramref name="newMatch"/> clears the
    /// match's history first.
    /// </summary>
    public Question TakeBankQuestion(bool newMatch)
    {
        lock (_gate)
        {
            if (_session is null) return CoupleQuizQuestionBank.Draw(new HashSet<string>());
            if (newMatch) _session.AskedQuestions.Clear();
            var question = CoupleQuizQuestionBank.Draw(_session.AskedQuestions);
            _session.AskedQuestions.Add(question.Text);
            return question;
        }
    }

    /// <summary>Begin a match with the given first question. Throws if there is no lobby.</summary>
    public Game StartGame(string questionText, string category)
    {
        lock (_gate)
        {
            var session = _session ?? throw new InvalidOperationException("No PoCoupleQuiz lobby to start.");

            var game = new Game { MaxRounds = session.MaxRounds };
            foreach (var p in session.Players)
            {
                game.AddPlayer(new Player { Name = p.Name });
            }

            game.CurrentQuestion = new GameQuestion
            {
                Text = questionText,
                Category = Enum.TryParse<QuestionCategory>(category, out var cat) ? cat : QuestionCategory.Preferences
            };
            game.CurrentRound = 0;

            session.ActiveGame = game;
            session.State = SessionState.InProgress;
            session.Phase = RoundPhase.Answering;
            session.LastEvaluatedRound = -1;

            return game;
        }
    }

    public bool RecordAnswer(string playerName, string answer)
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game || game.CurrentQuestion is not { } question) return false;

            // The King's submission is the round's secret answer; everyone else's is a guess.
            if (game.IsKing(playerName))
            {
                question.KingPlayerAnswer = answer;
            }
            else
            {
                question.PlayerAnswers[playerName] = answer;
            }
            return true;
        }
    }

    public Game AdvanceRound()
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game)
            {
                throw new InvalidOperationException("Cannot advance round: there is no active PoCoupleQuiz game.");
            }

            game.CurrentRound++;
            _session.Phase = RoundPhase.Answering;
            return game;
        }
    }

    public void ApplyRoundScores(Dictionary<string, int> pointsEarned)
    {
        lock (_gate)
        {
            if (_session?.ActiveGame is not { } game) return;
            foreach (var player in game.Players)
            {
                if (pointsEarned.TryGetValue(player.Name, out var pts))
                {
                    player.Score += pts;
                    player.TotalCorrectGuesses += pts > 0 ? 1 : 0;
                }
                player.TotalRoundsPlayed++;
            }
        }
    }

    public void FinishGame()
    {
        lock (_gate)
        {
            if (_session is null) return;
            _session.State = SessionState.Finished;
            _session.DisarmTimer();
        }
    }
}
