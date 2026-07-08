const express = require('express');
const Redis = require('ioredis');
const cors = require('cors');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const port = process.env.API_PORT || 3000;
const redisUrl = process.env.REDIS_URL || 'redis://redis:6379';

// Initialize normal Redis connection
const redis = new Redis(redisUrl);
redis.on('connect', () => console.log('Redis client connected.'));
redis.on('error', (err) => console.error('Redis error:', err));

// Initialize Sub Redis connection for Pub/Sub
const subRedis = new Redis(redisUrl);
subRedis.on('ready', () => {
  console.log('Sub Redis client connected and ready for Pub/Sub.');
  subRedis.subscribe('game:events');
});
subRedis.on('error', (err) => console.error('Sub Redis error:', err));

// Define Lua scripts using ioredis custom command definitions
redis.defineCommand('initializeSession', {
  numberOfKeys: 2,
  lua: `
    local userSessionsKey = KEYS[1]
    local newSessionKey = KEYS[2]

    local userId = ARGV[1]
    local newSessionId = ARGV[2]
    local ipAddress = ARGV[3]
    local deviceType = ARGV[4]
    local createdAt = ARGV[5]
    local lastActive = ARGV[6]
    local ttl = tonumber(ARGV[7])

    -- 1. Get and delete all old session hashes
    local oldSessions = redis.call('SMEMBERS', userSessionsKey)
    for _, oldSessionId in ipairs(oldSessions) do
        redis.call('DEL', 'session:' .. oldSessionId)
    end

    -- 2. Clear old session registrations
    redis.call('DEL', userSessionsKey)

    -- 3. Create the new session hash
    redis.call('HSET', newSessionKey,
        'userId', userId,
        'ipAddress', ipAddress,
        'deviceType', deviceType,
        'createdAt', createdAt,
        'lastActive', lastActive
    )
    redis.call('EXPIRE', newSessionKey, ttl)

    -- 4. Store the active session ID under the user set
    redis.call('SADD', userSessionsKey, newSessionId)
    redis.call('EXPIRE', userSessionsKey, ttl)

    return 1
  `
});

redis.defineCommand('submitQuizAnswer', {
  numberOfKeys: 3,
  lua: `
    local roundKey = KEYS[1]
    local submissionsKey = KEYS[2]
    local globalLeaderboardKey = KEYS[3]

    local playerId = ARGV[1]
    local answer = ARGV[2]
    local currentTime = tonumber(ARGV[3])

    -- 1. Check if round exists and is active
    local endTimeStr = redis.call('HGET', roundKey, 'endTime')
    if not endTimeStr then
        return {"ERROR", "ROUND_EXPIRED"}
    end

    local endTime = tonumber(endTimeStr)
    if currentTime >= endTime then
        return {"ERROR", "ROUND_EXPIRED"}
    end

    -- 2. Check if player has already submitted
    local alreadySubmitted = redis.call('SISMEMBER', submissionsKey, playerId)
    if alreadySubmitted == 1 then
        return {"ERROR", "DUPLICATE_SUBMISSION"}
    end

    -- 3. Record submission
    redis.call('SADD', submissionsKey, playerId)

    -- 4. Check correctness and update score
    local correctAnswer = redis.call('HGET', roundKey, 'correctAnswer')
    local pointsStr = redis.call('HGET', roundKey, 'points')
    local points = tonumber(pointsStr) or 10

    local scoreUpdated = 0
    local newScore = 0

    if correctAnswer == answer then
        newScore = tonumber(redis.call('ZINCRBY', globalLeaderboardKey, points, playerId))
        scoreUpdated = 1
    else
        local currentScoreStr = redis.call('ZSCORE', globalLeaderboardKey, playerId)
        newScore = tonumber(currentScoreStr) or 0
    end

    return {"SUCCESS", tostring(newScore), tostring(scoreUpdated)}
  `
});

// SSE active clients array
let sseClients = [];

// Listen for Redis Pub/Sub messages and push to active SSE clients
subRedis.on('message', (channel, message) => {
  if (channel === 'game:events') {
    try {
      const payload = JSON.parse(message);
      const { event, data } = payload;
      const sseFormatted = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      sseClients.forEach((client) => client.write(sseFormatted));
    } catch (err) {
      console.error('Error handling Pub/Sub message:', err);
    }
  }
});

// Helper function to broadcast score updates
async function broadcastLeaderboardUpdate(playerId, newScore) {
  await redis.publish('game:events', JSON.stringify({
    event: 'leaderboard_updated',
    data: { playerId, newScore: parseFloat(newScore) }
  }));
}

// ----------------------------------------------------
// REST API Routes
// ----------------------------------------------------

// 1. Healthcheck Endpoint
app.get('/health', async (req, res) => {
  try {
    const pingResult = await redis.ping();
    if (pingResult === 'PONG') {
      return res.status(200).json({ status: 'OK', redis: 'CONNECTED' });
    }
    return res.status(500).json({ status: 'ERROR', redis: 'UNHEALTHY' });
  } catch (error) {
    return res.status(500).json({ status: 'ERROR', error: error.message });
  }
});

// 2. Create User Session
app.post('/api/sessions', async (req, res) => {
  const { userId, ipAddress, deviceType } = req.body;
  if (!userId || !ipAddress || !deviceType) {
    return res.status(400).json({ error: 'userId, ipAddress, and deviceType are required.' });
  }

  const sessionId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const lastActive = createdAt;
  const ttl = 1800; // 30 minutes in seconds

  const userSessionsKey = `user_sessions:${userId}`;
  const newSessionKey = `session:${sessionId}`;

  try {
    // Run the Lua script to atomically invalidate old sessions and initialize the new one
    await redis.initializeSession(
      userSessionsKey,
      newSessionKey,
      userId,
      sessionId,
      ipAddress,
      deviceType,
      createdAt,
      lastActive,
      ttl
    );
    return res.status(201).json({ sessionId });
  } catch (error) {
    console.error('Error initializing session:', error);
    return res.status(500).json({ error: 'Failed to create session.' });
  }
});

// 3. Submit or Update Player Score (Atomic)
app.post('/api/leaderboard/scores', async (req, res) => {
  const { playerId, points } = req.body;
  if (!playerId || typeof points !== 'number') {
    return res.status(400).json({ error: 'playerId and numeric points are required.' });
  }

  try {
    const newScoreRaw = await redis.zincrby('leaderboard:global', points, playerId);
    const newScore = parseFloat(newScoreRaw);

    // Broadcast the updated score via Pub/Sub
    await broadcastLeaderboardUpdate(playerId, newScore);

    return res.status(200).json({ playerId, newScore });
  } catch (error) {
    console.error('Error submitting score:', error);
    return res.status(500).json({ error: 'Failed to update score.' });
  }
});

// 4. Get Top Players
app.get('/api/leaderboard/top/:count', async (req, res) => {
  const count = parseInt(req.params.count, 10);
  if (isNaN(count) || count <= 0) {
    return res.status(400).json({ error: 'Valid count parameter is required.' });
  }

  try {
    const list = await redis.zrevrange('leaderboard:global', 0, count - 1, 'WITHSCORES');
    const result = [];
    for (let i = 0; i < list.length; i += 2) {
      result.push({
        rank: Math.floor(i / 2) + 1,
        playerId: list[i],
        score: parseFloat(list[i + 1])
      });
    }
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error fetching top leaderboard:', error);
    return res.status(500).json({ error: 'Failed to fetch leaderboard.' });
  }
});

// 5. Get Player Rank & Nearby Players
app.get('/api/leaderboard/player/:playerId', async (req, res) => {
  const { playerId } = req.params;

  try {
    const zeroRank = await redis.zrevrank('leaderboard:global', playerId);
    if (zeroRank === null) {
      return res.status(404).json({ error: `Player ${playerId} not found on the leaderboard.` });
    }

    const scoreRaw = await redis.zscore('leaderboard:global', playerId);
    const score = parseFloat(scoreRaw);
    const rank = zeroRank + 1;
    const totalPlayers = await redis.zcard('leaderboard:global');

    // Percentile = ((totalPlayers - rank + 1) / totalPlayers) * 100
    const percentile = parseFloat((((totalPlayers - rank + 1) / totalPlayers) * 100).toFixed(2));

    // Nearby players: rank - 2 to rank + 2 (in 0-index: zeroRank - 2 to zeroRank + 2)
    const startIdx = Math.max(0, zeroRank - 2);
    const endIdx = zeroRank + 2;

    const rawList = await redis.zrevrange('leaderboard:global', startIdx, endIdx, 'WITHSCORES');
    const parsedNearby = [];
    for (let i = 0; i < rawList.length; i += 2) {
      parsedNearby.push({
        rank: startIdx + Math.floor(i / 2) + 1,
        playerId: rawList[i],
        score: parseFloat(rawList[i + 1])
      });
    }

    // Split into above and below, excluding the player themselves
    const above = parsedNearby.filter((p) => p.rank < rank);
    const below = parsedNearby.filter((p) => p.rank > rank);

    return res.status(200).json({
      playerId,
      score,
      rank,
      percentile,
      nearbyPlayers: {
        above,
        below
      }
    });
  } catch (error) {
    console.error('Error fetching player stats:', error);
    return res.status(500).json({ error: 'Failed to fetch player stats.' });
  }
});

// 6. Submit Game Round Answer (Atomic Lua)
app.post('/api/game/submit', async (req, res) => {
  const { gameId, roundId, playerId, answer } = req.body;
  if (!gameId || !roundId || !playerId || !answer) {
    return res.status(400).json({ error: 'gameId, roundId, playerId, and answer are required.' });
  }

  const roundKey = `game_round:${gameId}:${roundId}`;
  const submissionsKey = `submissions:${gameId}:${roundId}`;
  const globalLeaderboardKey = 'leaderboard:global';
  const currentTime = Math.floor(Date.now() / 1000); // Unix timestamp in seconds

  try {
    const result = await redis.submitQuizAnswer(
      roundKey,
      submissionsKey,
      globalLeaderboardKey,
      playerId,
      answer,
      currentTime
    );

    const status = result[0];
    const codeOrScore = result[1];
    const scoreUpdated = result[2];

    if (status === 'ERROR') {
      if (codeOrScore === 'ROUND_EXPIRED') {
        return res.status(403).json({ status: 'ERROR', code: 'ROUND_EXPIRED' });
      }
      if (codeOrScore === 'DUPLICATE_SUBMISSION') {
        return res.status(400).json({ status: 'ERROR', code: 'DUPLICATE_SUBMISSION' });
      }
      return res.status(500).json({ status: 'ERROR', code: codeOrScore });
    }

    const newScore = parseFloat(codeOrScore);
    if (scoreUpdated === '1') {
      await broadcastLeaderboardUpdate(playerId, newScore);
    }

    return res.status(200).json({ status: 'SUCCESS', newScore });
  } catch (error) {
    console.error('Error submitting quiz answer:', error);
    return res.status(500).json({ error: 'Failed to submit answer.' });
  }
});

// 7. SSE Events endpoint
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write('\n'); // keepalive/initialize connection

  // Keep track of connected clients
  sseClients.push(res);
  console.log(`SSE Client connected. Total active connections: ${sseClients.length}`);

  req.on('close', () => {
    sseClients = sseClients.filter((client) => client !== res);
    console.log(`SSE Client disconnected. Total active connections: ${sseClients.length}`);
  });
});

// 8. Admin GET active sessions for a user
app.get('/api/admin/sessions/user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const userSessionsKey = `user_sessions:${userId}`;
    const sessionIds = await redis.smembers(userSessionsKey);
    const activeSessions = [];
    const expiredSessionIds = [];

    for (const sessionId of sessionIds) {
      const sessionData = await redis.hgetall(`session:${sessionId}`);
      if (sessionData && Object.keys(sessionData).length > 0) {
        activeSessions.push({
          sessionId,
          ipAddress: sessionData.ipAddress,
          lastActive: sessionData.lastActive,
          deviceType: sessionData.deviceType
        });
      } else {
        expiredSessionIds.push(sessionId);
      }
    }

    // Clean up expired session ids from user's active set index
    if (expiredSessionIds.length > 0) {
      await redis.srem(userSessionsKey, ...expiredSessionIds);
    }

    return res.status(200).json(activeSessions);
  } catch (error) {
    console.error('Error fetching admin sessions:', error);
    return res.status(500).json({ error: 'Failed to fetch sessions.' });
  }
});

// 9. Admin DELETE a single session
app.delete('/api/admin/sessions/:sessionId', async (req, res) => {
  const { sessionId } = req.params;

  try {
    const sessionKey = `session:${sessionId}`;
    const userId = await redis.hget(sessionKey, 'userId');
    if (userId) {
      await redis.del(sessionKey);
      await redis.srem(`user_sessions:${userId}`, sessionId);
    } else {
      // In case session exists but userId field is missing, just try to delete it
      await redis.del(sessionKey);
    }
    return res.status(204).end();
  } catch (error) {
    console.error('Error invalidating session:', error);
    return res.status(500).json({ error: 'Failed to invalidate session.' });
  }
});

// 10. Admin endpoint to seed a round (Convenient for manual testing & verification)
app.post('/api/admin/rounds', async (req, res) => {
  const { gameId, roundId, correctAnswer, points, durationSeconds } = req.body;
  if (!gameId || !roundId || !correctAnswer || typeof points !== 'number' || typeof durationSeconds !== 'number') {
    return res.status(400).json({ error: 'gameId, roundId, correctAnswer, points and durationSeconds are required.' });
  }

  try {
    const roundKey = `game_round:${gameId}:${roundId}`;
    const endTime = Math.floor(Date.now() / 1000) + durationSeconds;
    await redis.hset(roundKey,
      'correctAnswer', correctAnswer,
      'points', points.toString(),
      'endTime', endTime.toString()
    );
    // Expire the round metadata after 1 hour (3600s) to keep Redis clean
    await redis.expire(roundKey, 3600);

    return res.status(201).json({ message: 'Round seeded successfully.', endTime });
  } catch (error) {
    console.error('Error seeding round:', error);
    return res.status(500).json({ error: 'Failed to seed round.' });
  }
});

// Start the Express server
app.listen(port, () => {
  console.log(`Game API Server listening on port ${port}`);
});
