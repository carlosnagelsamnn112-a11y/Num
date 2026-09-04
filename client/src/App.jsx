import { useState, useEffect, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import './App.css';

const socketUrl = import.meta.env.VITE_SOCKET_URL
  || (window.location.hostname === 'localhost' ? 'http://localhost:3001' : window.location.origin);
const socket = io(socketUrl, { transports: ['websocket', 'polling'], path: '/socket.io' });

export default function App() {
  const [view, setView] = useState('home');
  const [room, setRoom] = useState(null);
  const [playerId, setPlayerId] = useState(null);
  const [gameData, setGameData] = useState(null);
  const [countdown, setCountdown] = useState(3);
  const [roundResult, setRoundResult] = useState(null);
  const [gameOver, setGameOver] = useState(null);
  const [error, setError] = useState('');
  const [myNumber, setMyNumber] = useState(null);
  const [attemptsLeft, setAttemptsLeft] = useState(3);
  const [guessInput, setGuessInput] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [round, setRound] = useState(1);
  const [scores, setScores] = useState([]);
  const inputRef = useRef(null);

  const resetGameState = useCallback(() => {
    setGameData(null);
    setMyNumber(null);
    setRoundResult(null);
    setGameOver(null);
    setFeedback(null);
    setGuessInput('');
    setAttemptsLeft(3);
  }, []);

  useEffect(() => {
    socket.on('room:created', (data) => {
      setRoom({ ...data, gameState: 'waiting' });
      setPlayerId(data.playerId);
      setView('room');
      setError('');
    });

    socket.on('room:joined', (data) => {
      setRoom({ ...data, gameState: 'waiting' });
      setPlayerId(data.playerId);
      setView('room');
      setError('');
    });

    socket.on('room:state', (data) => {
      setRoom(prev => prev ? { ...prev, ...data } : null);
    });

    socket.on('room:error', ({ message }) => {
      setError(message);
    });

    socket.on('game:countdown', () => {
      resetGameState();
      setView('countdown');
      setCountdown(3);
    });

    socket.on('game:start', (data) => {
      setGameData(data);
      setRound(data.round);
      setScores(data.scores);
      setAttemptsLeft(data.attemptsLeft);
      setMyNumber(null);
      setRoundResult(null);
      setGameOver(null);
      setFeedback(null);
      setGuessInput('');
      setView('game');
      setTimeout(() => inputRef.current?.focus(), 300);
    });

    socket.on('guess:correct', ({ number, attemptsLeft }) => {
      setMyNumber(number);
      setAttemptsLeft(attemptsLeft);
      setFeedback({ type: 'correct', message: `Correct! Your number is ${number}` });
    });

    socket.on('guess:wrong', ({ attemptsLeft, message }) => {
      setAttemptsLeft(attemptsLeft);
      setFeedback({ type: 'wrong', message });
      setGuessInput('');
      if (attemptsLeft > 0) setTimeout(() => inputRef.current?.focus(), 200);
    });

    socket.on('round:over', (data) => {
      setRoundResult(data);
      setScores(data.scores);
      if (!myNumber && data.numbers && playerId) {
        setMyNumber(data.numbers[playerId]);
      }
      setView('results');
    });

    socket.on('game:over', (data) => {
      setGameOver(data);
    });

    socket.on('game:cancelled', ({ message }) => {
      resetGameState();
      setView('room');
      setError(message);
    });

    return () => {
      socket.off('room:created');
      socket.off('room:joined');
      socket.off('room:state');
      socket.off('room:error');
      socket.off('game:countdown');
      socket.off('game:start');
      socket.off('guess:correct');
      socket.off('guess:wrong');
      socket.off('round:over');
      socket.off('game:over');
      socket.off('game:cancelled');
    };
  }, [playerId, myNumber, resetGameState]);

  useEffect(() => {
    if (view !== 'countdown') return;
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown, view]);

  const handleCreate = (username, digits) => {
    setError('');
    socket.emit('room:create', { username, digits });
  };

  const handleJoin = (username, roomId) => {
    setError('');
    socket.emit('room:join', { roomId: roomId.toUpperCase(), username });
  };

  const handleStart = () => socket.emit('game:start');

  const handleGuess = () => {
    const num = parseInt(guessInput, 10);
    if (isNaN(num) || guessInput.trim() === '') {
      setFeedback({ type: 'error', message: 'Enter a valid number' });
      return;
    }
    setFeedback(null);
    socket.emit('game:guess', { guess: num });
  };

  const handleLeave = () => {
    socket.emit('room:leave');
    resetGameState();
    setRoom(null);
    setPlayerId(null);
    setView('home');
  };

  const handleNextRound = () => socket.emit('game:next_round');

  const handlePlayAgain = () => {
    socket.emit('game:reset');
    resetGameState();
  };

  return (
    <div className="app">
      {view === 'home' && (
        <HomeView
          onCreate={handleCreate}
          onJoin={handleJoin}
          error={error}
          setError={setError}
        />
      )}
      {view === 'room' && room && (
        <RoomView
          room={room}
          playerId={playerId}
          onStart={handleStart}
          onLeave={handleLeave}
        />
      )}
      {view === 'countdown' && <CountdownScreen value={countdown} />}
      {view === 'game' && gameData && (
        <GameView
          gameData={gameData}
          playerId={playerId}
          attemptsLeft={attemptsLeft}
          guessInput={guessInput}
          setGuessInput={setGuessInput}
          feedback={feedback}
          myNumber={myNumber}
          onGuess={handleGuess}
          round={round}
          scores={scores}
          inputRef={inputRef}
        />
      )}
      {view === 'results' && roundResult && (
        <ResultsView
          result={roundResult}
          playerId={playerId}
          gameOver={gameOver}
          onPlayAgain={handlePlayAgain}
          onNextRound={handleNextRound}
          onLeave={handleLeave}
        />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   HOME VIEW
   ═══════════════════════════════════════════════════════════════════ */

function HomeView({ onCreate, onJoin, error, setError }) {
  const [mode, setMode] = useState(null);
  const [username, setUsername] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [digits, setDigits] = useState(3);

  const handleCreate = () => {
    if (!username.trim()) { setError('Enter a username'); return; }
    onCreate(username.trim(), digits);
  };

  const handleJoinRoom = () => {
    if (!username.trim()) { setError('Enter a username'); return; }
    if (!roomCode.trim()) { setError('Enter a room code'); return; }
    onJoin(username.trim(), roomCode.trim());
  };

  return (
    <div className="view home">
      <div className="home-content">
        <h1 className="logo">NUM</h1>
        <p className="tagline">Guess your number before anyone else</p>

        {error && <div className="error-msg">{error}</div>}

        {!mode && (
          <div className="menu-buttons">
            <button className="btn btn-primary" onClick={() => setMode('create')}>
              Create Room
            </button>
            <button className="btn btn-secondary" onClick={() => setMode('join')}>
              Join Room
            </button>
          </div>
        )}

        {mode === 'create' && (
          <div className="form-card">
            <h2>Create Room</h2>
            <input
              type="text"
              placeholder="Username"
              maxLength={15}
              value={username}
              onChange={e => setUsername(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              autoFocus
            />
            <div className="digits-select">
              <label>Number of digits:</label>
              <div className="digit-options">
                {[2, 3, 4].map(d => (
                  <button
                    key={d}
                    className={`digit-btn ${digits === d ? 'active' : ''}`}
                    onClick={() => setDigits(d)}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleCreate}>
              Create
            </button>
            <button className="btn btn-text" onClick={() => { setMode(null); setError(''); }}>
              Back
            </button>
          </div>
        )}

        {mode === 'join' && (
          <div className="form-card">
            <h2>Join Room</h2>
            <input
              type="text"
              placeholder="Username"
              maxLength={15}
              value={username}
              onChange={e => setUsername(e.target.value)}
              autoFocus
            />
            <input
              type="text"
              placeholder="Room code (e.g. AB12)"
              maxLength={4}
              value={roomCode}
              onChange={e => setRoomCode(e.target.value.toUpperCase())}
              onKeyDown={e => e.key === 'Enter' && handleJoinRoom()}
            />
            <button className="btn btn-primary" onClick={handleJoinRoom}>
              Join
            </button>
            <button className="btn btn-text" onClick={() => { setMode(null); setError(''); }}>
              Back
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   ROOM VIEW
   ═══════════════════════════════════════════════════════════════════ */

function RoomView({ room, playerId, onStart, onLeave }) {
  const isCreator = room.players[0]?.id === playerId;
  const canStart = room.players.length >= 2 && isCreator;

  return (
    <div className="view room-view">
      <div className="room-card">
        <button className="btn btn-text leave-btn" onClick={onLeave}>
          Leave
        </button>
        <h2>Room</h2>
        <div className="room-code-label">Share this code</div>
        <div className="room-code">{room.roomId}</div>

        <div className="room-config">
          <span className="config-badge">{room.config.digits} digits</span>
          <span className="config-badge">{room.players.length} player{room.players.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="player-list">
          <h3>Players</h3>
          {room.players.map(p => (
            <div key={p.id} className="player-item">
              <span className="player-dot" />
              <span className="player-name">{p.name}</span>
              {p.id === playerId && <span className="you-tag">you</span>}
              {p.id === room.players[0]?.id && <span className="host-tag">host</span>}
            </div>
          ))}
        </div>

        {isCreator ? (
          <button
            className="btn btn-primary btn-large"
            disabled={!canStart}
            onClick={onStart}
          >
            {canStart ? 'Start Game' : `Need ${Math.max(0, 2 - room.players.length)} more`}
          </button>
        ) : (
          <p className="waiting-text">Waiting for host to start...</p>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   COUNTDOWN
   ═══════════════════════════════════════════════════════════════════ */

function CountdownScreen({ value }) {
  return (
    <div className="view countdown">
      <div className={`countdown-number ${value === 0 ? 'go' : ''}`}>
        {value > 0 ? value : 'GO!'}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   GAME VIEW
   ═══════════════════════════════════════════════════════════════════ */

function GameView({ gameData, playerId, attemptsLeft, guessInput, setGuessInput, feedback, myNumber, onGuess, round, scores, inputRef }) {
  const others = Object.entries(gameData.numbers);

  return (
    <div className="view game-view">
      <div className="game-header">
        <div className="round-badge">Round {round}</div>
        <div className="scores-bar">
          {scores.map(s => (
            <div key={s.id} className={`score-chip ${s.id === playerId ? 'me' : ''}`}>
              {s.name}: {s.score}
            </div>
          ))}
        </div>
      </div>

      <div className="numbers-grid">
        <div className="number-card mine">
          <div className="card-label">Your number</div>
          <div className="card-number masked">???</div>
        </div>
        {others.map(([id, data]) => (
          <div key={id} className="number-card other">
            <div className="card-label">{data.name}</div>
            <div className="card-number">{data.number}</div>
          </div>
        ))}
      </div>

      {myNumber !== null ? (
        <div className="game-result reveal">
          <div className="reveal-number">{myNumber}</div>
          <p>That was your number!</p>
        </div>
      ) : (
        <div className="guess-section">
          <div className="attempts-display">
            Attempts: {Array.from({ length: 3 }, (_, i) => (
              <span key={i} className={`attempt-dot ${i < attemptsLeft ? 'filled' : 'empty'}`}>●</span>
            ))}
          </div>
          {feedback && (
            <div className={`feedback ${feedback.type}`}>{feedback.message}</div>
          )}
          {attemptsLeft > 0 && (
            <div className="guess-row">
              <input
                ref={inputRef}
                type="number"
                className="guess-input"
                placeholder="Your guess..."
                value={guessInput}
                onChange={e => setGuessInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && onGuess()}
              />
              <button className="btn btn-primary" onClick={onGuess}>
                Guess
              </button>
            </div>
          )}
          {attemptsLeft <= 0 && !feedback && (
            <div className="feedback wrong">You ran out of attempts</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   RESULTS VIEW
   ═══════════════════════════════════════════════════════════════════ */

function ResultsView({ result, playerId, gameOver, onPlayAgain, onNextRound, onLeave }) {
  const iWon = result.winnerId === playerId;

  return (
    <div className="view results-view">
      <div className="results-card">
        <h2>{gameOver ? 'Game Over' : 'Round Over'}</h2>

        {result.winnerId ? (
          <div className={`result-banner ${iWon ? 'won' : 'lost'}`}>
            {iWon ? 'You guessed it!' : `${result.scores.find(s => s.id === result.winnerId)?.name} guessed correctly!`}
          </div>
        ) : (
          <div className="result-banner nobody">Nobody guessed correctly</div>
        )}

        <div className="final-scores">
          {result.scores.sort((a, b) => b.score - a.score).map((s, i) => (
            <div key={s.id} className={`score-row ${s.id === playerId ? 'me' : ''} ${s.id === result.winnerId ? 'winner' : ''}`}>
              <span className="rank">#{i + 1}</span>
              <span className="name">{s.name}{s.id === playerId ? ' (you)' : ''}</span>
              <span className="score">{s.score} win{s.score !== 1 ? 's' : ''}</span>
            </div>
          ))}
        </div>

        {gameOver ? (
          <div className="game-over-actions">
            <p className="champion-text">
              {result.scores.find(s => s.score === Math.max(...result.scores.map(x => x.score)))?.name} wins the game!
            </p>
            <button className="btn btn-primary" onClick={onPlayAgain}>Play Again</button>
            <button className="btn btn-text" onClick={onLeave}>Leave</button>
          </div>
        ) : (
          <button className="btn btn-primary" onClick={onNextRound}>Next Round</button>
        )}
      </div>
    </div>
  );
}
