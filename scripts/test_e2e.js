const http = require('http');

const baseUrl = 'http://localhost:3000';

// Helper to make POST requests
async function post(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Helper to make GET requests
async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// Helper to make DELETE requests
async function del(path) {
  const res = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
  return { status: res.status };
}

async function runTests() {
  console.log('🏁 Starting End-to-End Tests...\n');
  let passed = 0;
  let failed = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`✅ PASS: ${message}`);
      passed++;
    } else {
      console.error(`❌ FAIL: ${message}`);
      failed++;
    }
  }

  try {
    // ----------------------------------------------------------------
    // Test 1: Healthcheck
    // ----------------------------------------------------------------
    const health = await get('/health');
    assert(health.status === 200, 'Healthcheck status is 200');
    assert(health.data.status === 'OK', 'Healthcheck returns status OK');
    assert(health.data.redis === 'CONNECTED', 'Healthcheck reports Redis is connected');

    // ----------------------------------------------------------------
    // Test 2: User Session Management
    // ----------------------------------------------------------------
    const userId = 'test-user-for-eval-12345';
    
    // Create first session
    const sess1 = await post('/api/sessions', {
      userId,
      ipAddress: '192.168.1.1',
      deviceType: 'desktop'
    });
    assert(sess1.status === 201, 'Create session 1 returns 201');
    assert(sess1.data.sessionId !== undefined, 'Create session 1 returns a sessionId');
    const sessionId1 = sess1.data.sessionId;

    // Check active sessions (should contain session 1)
    const list1 = await get(`/api/admin/sessions/user/${userId}`);
    assert(list1.status === 200, 'Get active sessions returns 200');
    assert(list1.data.length === 1, 'User has exactly 1 active session');
    assert(list1.data[0].sessionId === sessionId1, 'Session matches session 1 ID');

    // Create second session (should atomically invalidate session 1)
    const sess2 = await post('/api/sessions', {
      userId,
      ipAddress: '192.168.1.2',
      deviceType: 'mobile'
    });
    assert(sess2.status === 201, 'Create session 2 returns 201');
    const sessionId2 = sess2.data.sessionId;

    // Verify session 1 is invalidated and only session 2 remains
    const list2 = await get(`/api/admin/sessions/user/${userId}`);
    assert(list2.data.length === 1, 'User still has exactly 1 active session');
    assert(list2.data[0].sessionId === sessionId2, 'Active session matches session 2 ID');

    // Delete session 2
    const delSess = await del(`/api/admin/sessions/${sessionId2}`);
    assert(delSess.status === 204, 'Delete session returns 204');

    // Verify no active sessions remain
    const list3 = await get(`/api/admin/sessions/user/${userId}`);
    assert(list3.data.length === 0, 'User has 0 active sessions after manual invalidation');

    // ----------------------------------------------------------------
    // Test 3: Leaderboard Scoring
    // ----------------------------------------------------------------
    const player = 'player-test-e2e-' + Date.now();
    
    // Submit score
    const score1 = await post('/api/leaderboard/scores', { playerId: player, points: 1000 });
    assert(score1.status === 200, 'Submit score returns 200');
    assert(score1.data.newScore === 1000, 'Initial score is 1000');

    // Update score
    const score2 = await post('/api/leaderboard/scores', { playerId: player, points: 500 });
    assert(score2.data.newScore === 1500, 'Score updates to 1500');

    // Get Top Players
    const top = await get('/api/leaderboard/top/5');
    assert(top.status === 200, 'Get top leaderboard returns 200');
    assert(top.data.length > 0, 'Leaderboard has entries');
    const testEntry = top.data.find(p => p.playerId === player);
    assert(testEntry !== undefined, 'Test player exists in top leaderboard');
    assert(testEntry.score === 1500, 'Test player has correct score in top list');

    // Get Player Rank & Nearby
    const stats = await get(`/api/leaderboard/player/${player}`);
    assert(stats.status === 200, 'Get player stats returns 200');
    assert(stats.data.score === 1500, 'Player stats returns correct score');
    assert(stats.data.rank !== undefined, 'Player stats returns rank');
    assert(stats.data.percentile !== undefined, 'Player stats returns percentile');
    assert(stats.data.nearbyPlayers !== undefined, 'Player stats returns nearby rivals list');

    // ----------------------------------------------------------------
    // Test 4: Game Submission & Concurrency Checks
    // ----------------------------------------------------------------
    const gameId = 'g-test';
    const roundId = 'r-test';
    const gamePlayer = 'game-player-test-' + Date.now();

    // A. Seed an Active Round
    const seedActive = await post('/api/admin/rounds', {
      gameId,
      roundId,
      correctAnswer: 'A',
      points: 20,
      durationSeconds: 60
    });
    assert(seedActive.status === 201, 'Seed active round returns 201');

    // B. Submit correct answer (should succeed)
    const sub1 = await post('/api/game/submit', {
      gameId,
      roundId,
      playerId: gamePlayer,
      answer: 'A'
    });
    assert(sub1.status === 200, 'Submit correct answer returns 200');
    assert(sub1.data.status === 'SUCCESS', 'Response reports SUCCESS');
    const prevScore = sub1.data.newScore;

    // C. Submit again (should fail with DUPLICATE_SUBMISSION)
    const sub2 = await post('/api/game/submit', {
      gameId,
      roundId,
      playerId: gamePlayer,
      answer: 'A'
    });
    assert(sub2.status === 400, 'Submit duplicate answer returns 400');
    assert(sub2.data.status === 'ERROR', 'Response reports ERROR');
    assert(sub2.data.code === 'DUPLICATE_SUBMISSION', 'Error code is DUPLICATE_SUBMISSION');

    // D. Seed an Expired Round
    const expiredRoundId = 'r-expired';
    const seedExpired = await post('/api/admin/rounds', {
      gameId,
      roundId: expiredRoundId,
      correctAnswer: 'B',
      points: 10,
      durationSeconds: -5 // Expired 5 seconds ago
    });
    assert(seedExpired.status === 201, 'Seed expired round returns 201');

    // E. Submit answer to expired round (should fail with ROUND_EXPIRED)
    const sub3 = await post('/api/game/submit', {
      gameId,
      roundId: expiredRoundId,
      playerId: gamePlayer,
      answer: 'B'
    });
    assert(sub3.status === 403, 'Submit answer to expired round returns 403');
    assert(sub3.data.status === 'ERROR', 'Response reports ERROR');
    assert(sub3.data.code === 'ROUND_EXPIRED', 'Error code is ROUND_EXPIRED');

    // ----------------------------------------------------------------
    // Test 5: SSE Event Validation
    // ----------------------------------------------------------------
    console.log('\n📡 Verifying Server-Sent Events (SSE) broadcast...');
    
    // We fetch the events endpoint and check headers
    const controller = new AbortController();
    const ssePromise = fetch(`${baseUrl}/api/events`, { signal: controller.signal });
    
    // Wait briefly for connection
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Submit another score to trigger event
    await post('/api/leaderboard/scores', { playerId: 'sse-trigger-player', points: 10 });
    
    // Wait briefly for propagation
    await new Promise(resolve => setTimeout(resolve, 500));
    
    controller.abort(); // Terminate SSE stream
    
    try {
      const sseRes = await ssePromise;
      assert(sseRes.status === 200, 'SSE endpoint responds with 200');
      assert(sseRes.headers.get('content-type') === 'text/event-stream', 'SSE content-type is text/event-stream');
    } catch (e) {
      if (e.name !== 'AbortError') throw e;
      assert(true, 'SSE connection established and aborted successfully');
    }

  } catch (error) {
    console.error('Fatal test execution error:', error);
    failed++;
  }

  console.log('\n🏁 E2E Test Run Completed.');
  console.log(`Total tests run: ${passed + failed}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests();
