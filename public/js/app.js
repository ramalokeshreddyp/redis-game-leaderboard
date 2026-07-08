document.addEventListener('DOMContentLoaded', () => {
  // DOM Elements
  const connectionStatus = document.getElementById('connectionStatus');
  const eventTicker = document.getElementById('eventTicker');
  const leaderboardBody = document.getElementById('leaderboardBody');
  const btnRefreshLeaderboard = document.getElementById('btnRefreshLeaderboard');

  // Stats Finder
  const txtSearchPlayerId = document.getElementById('txtSearchPlayerId');
  const btnSearchPlayer = document.getElementById('btnSearchPlayer');
  const playerStatsResult = document.getElementById('playerStatsResult');
  const playerStatsEmpty = document.getElementById('playerStatsEmpty');
  const lblPlayerRank = document.getElementById('lblPlayerRank');
  const lblPlayerScore = document.getElementById('lblPlayerScore');
  const lblPlayerPercentile = document.getElementById('lblPlayerPercentile');
  const lblPlayerPercentileText = document.getElementById('lblPlayerPercentileText');
  const pbPlayerPercentile = document.getElementById('pbPlayerPercentile');
  const rivalList = document.getElementById('rivalList');

  // Quiz Console
  const btnSeedActiveRound = document.getElementById('btnSeedActiveRound');
  const btnSeedExpiredRound = document.getElementById('btnSeedExpiredRound');
  const frmSubmitAnswer = document.getElementById('frmSubmitAnswer');
  const txtGameId = document.getElementById('txtGameId');
  const txtRoundId = document.getElementById('txtRoundId');
  const txtGamePlayerId = document.getElementById('txtGamePlayerId');
  const txtAnswer = document.getElementById('txtAnswer');
  const gameConsoleLog = document.getElementById('gameConsoleLog');

  // Admin Session Manager
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  const txtAdminUserId = document.getElementById('txtAdminUserId');
  const btnFindSessions = document.getElementById('btnFindSessions');
  const sessionsResults = document.getElementById('sessionsResults');
  
  const frmCreateSession = document.getElementById('frmCreateSession');
  const txtNewSessionUserId = document.getElementById('txtNewSessionUserId');
  const txtNewSessionIp = document.getElementById('txtNewSessionIp');
  const selNewSessionDevice = document.getElementById('selNewSessionDevice');
  const sessionCreateLog = document.getElementById('sessionCreateLog');

  // Local State
  let currentLeaderboard = [];
  let searchedPlayerId = '';
  let eventSource = null;

  // Initialize
  initSSE();
  fetchLeaderboard();

  // Event Listeners
  btnRefreshLeaderboard.addEventListener('click', fetchLeaderboard);
  btnSearchPlayer.addEventListener('click', () => {
    searchedPlayerId = txtSearchPlayerId.value.trim();
    if (searchedPlayerId) fetchPlayerStats(searchedPlayerId);
  });

  // Admin Tab Switching
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      const targetTab = document.getElementById(btn.dataset.tab);
      if (targetTab) targetTab.classList.add('active');
    });
  });

  // Admin Action listeners
  btnFindSessions.addEventListener('click', fetchUserSessions);
  frmCreateSession.addEventListener('submit', registerUserSession);

  // Seeding Shortcuts
  btnSeedActiveRound.addEventListener('click', () => seedRound(true));
  btnSeedExpiredRound.addEventListener('click', () => seedRound(false));

  // Game Submission
  frmSubmitAnswer.addEventListener('submit', submitQuizAnswer);

  // ----------------------------------------------------
  // Core Functions
  // ----------------------------------------------------

  // 1. Establish SSE Connection
  function initSSE() {
    updateConnectionStatus('connecting', 'Connecting to live events...');

    if (eventSource) {
      eventSource.close();
    }

    eventSource = new EventSource('/api/events');

    eventSource.onopen = () => {
      updateConnectionStatus('connected', 'Live Stream Connected');
    };

    eventSource.onerror = (err) => {
      console.error('SSE connection error:', err);
      updateConnectionStatus('disconnected', 'Live Stream Offline (Retrying...)');
    };

    // Listen for leaderboard updates
    eventSource.addEventListener('leaderboard_updated', (e) => {
      try {
        const data = JSON.parse(e.data);
        addTickerMessage(`Player <strong>${data.playerId}</strong> score updated to <strong>${data.newScore}</strong>!`);
        
        // Refresh leaderboard visually
        fetchLeaderboard(data.playerId);

        // If this is the active searched player, update their stats finder
        if (searchedPlayerId && searchedPlayerId.toLowerCase() === data.playerId.toLowerCase()) {
          fetchPlayerStats(searchedPlayerId);
        }
      } catch (err) {
        console.error('Failed to parse event data:', err);
      }
    });
  }

  function updateConnectionStatus(type, text) {
    const indicator = connectionStatus.querySelector('.status-indicator');
    const label = connectionStatus.querySelector('.status-text');
    
    indicator.className = 'status-indicator';
    indicator.classList.add(type);
    label.textContent = text;
  }

  // 2. Add Item to scrolling ticker
  function addTickerMessage(htmlContent) {
    const item = document.createElement('div');
    item.className = 'ticker-item update-msg';
    item.innerHTML = `<i class="fa-solid fa-bell"></i> ${htmlContent}`;
    
    eventTicker.appendChild(item);

    // Keep ticker clean by removing old items if too long
    const items = eventTicker.querySelectorAll('.ticker-item');
    if (items.length > 5) {
      eventTicker.removeChild(items[0]);
    }
  }

  // 3. Fetch Leaderboard
  async function fetchLeaderboard(highlightPlayerId = '') {
    try {
      const response = await fetch('/api/leaderboard/top/10');
      if (!response.ok) throw new Error('Failed to load leaderboard');
      const data = await response.json();
      
      renderLeaderboard(data, highlightPlayerId);
      currentLeaderboard = data;
    } catch (err) {
      console.error(err);
      leaderboardBody.innerHTML = `
        <tr>
          <td colspan="3" class="table-loading" style="color: var(--red);">
            <i class="fa-solid fa-circle-exclaim"></i> Failed to connect to API server.
          </td>
        </tr>
      `;
    }
  }

  function renderLeaderboard(players, highlightPlayerId = '') {
    if (players.length === 0) {
      leaderboardBody.innerHTML = `
        <tr>
          <td colspan="3" class="table-loading">
            No score entries recorded yet.
          </td>
        </tr>
      `;
      return;
    }

    leaderboardBody.innerHTML = '';
    players.forEach(player => {
      const tr = document.createElement('tr');
      if (highlightPlayerId && player.playerId.toLowerCase() === highlightPlayerId.toLowerCase()) {
        tr.classList.add('row-highlight');
      }

      let rankDisplay = `<span class="rank-badge rank-other">${player.rank}</span>`;
      if (player.rank === 1) rankDisplay = `<span class="rank-badge rank-1"><i class="fa-solid fa-crown" style="font-size:0.75rem; margin-right:2px;"></i>1</span>`;
      else if (player.rank === 2) rankDisplay = `<span class="rank-badge rank-2">2</span>`;
      else if (player.rank === 3) rankDisplay = `<span class="rank-badge rank-3">3</span>`;

      tr.innerHTML = `
        <td class="col-rank">${rankDisplay}</td>
        <td class="col-player">${escapeHtml(player.playerId)}</td>
        <td class="col-score">${player.score}</td>
      `;
      leaderboardBody.appendChild(tr);
    });
  }

  // 4. Fetch Player Stats & Nearby Rivals
  async function fetchPlayerStats(playerId) {
    try {
      const response = await fetch(`/api/leaderboard/player/${encodeURIComponent(playerId)}`);
      
      if (response.status === 404) {
        playerStatsEmpty.classList.remove('hidden');
        playerStatsEmpty.innerHTML = `
          <i class="fa-solid fa-user-xmark" style="color: var(--red);"></i>
          <p>Player <strong>${escapeHtml(playerId)}</strong> not found on global leaderboard.</p>
        `;
        playerStatsResult.classList.add('hidden');
        return;
      }
      if (!response.ok) throw new Error('Search failed');

      const data = await response.json();
      
      // Render Stats
      lblPlayerRank.textContent = `#${data.rank}`;
      lblPlayerScore.textContent = data.score;
      lblPlayerPercentile.textContent = `${data.percentile}%`;
      lblPlayerPercentileText.textContent = `${data.percentile}%`;
      pbPlayerPercentile.style.width = `${data.percentile}%`;

      // Render rivals
      rivalList.innerHTML = '';
      
      // Merge above, self, below to list in order
      const rivals = [];
      if (data.nearbyPlayers.above) rivals.push(...data.nearbyPlayers.above);
      rivals.push({ rank: data.rank, playerId: data.playerId, score: data.score, isSelf: true });
      if (data.nearbyPlayers.below) rivals.push(...data.nearbyPlayers.below);

      // Sort by rank ascending
      rivals.sort((a, b) => a.rank - b.rank);

      rivals.forEach(rival => {
        const item = document.createElement('div');
        item.className = 'rival-item';
        if (rival.isSelf) item.classList.add('rival-self');

        item.innerHTML = `
          <div class="rival-meta">
            <span class="rival-rank">#${rival.rank}</span>
            <span class="rival-name">${escapeHtml(rival.playerId)} ${rival.isSelf ? '(You)' : ''}</span>
          </div>
          <span class="rival-score">${rival.score} pts</span>
        `;
        rivalList.appendChild(item);
      });

      playerStatsEmpty.classList.add('hidden');
      playerStatsResult.classList.remove('hidden');
    } catch (err) {
      console.error(err);
      playerStatsEmpty.classList.remove('hidden');
      playerStatsEmpty.innerHTML = `
        <i class="fa-solid fa-triangle-exclamation" style="color: var(--red);"></i>
        <p>Error retrieving stats for player.</p>
      `;
      playerStatsResult.classList.add('hidden');
    }
  }

  // 5. Seed Round Helper
  async function seedRound(isActive) {
    const gameId = txtGameId.value.trim() || 'g-501';
    const roundId = txtRoundId.value.trim() || 'r-3';
    const correctAnswer = isActive ? 'A' : 'B';
    const points = isActive ? 15 : 10;
    const durationSeconds = isActive ? 60 : -5; // Expired uses negative offset

    showConsoleLog('gameConsoleLog', `Seeding round ${roundId} for game ${gameId}...`, 'info');

    try {
      const response = await fetch('/api/admin/rounds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, roundId, correctAnswer, points, durationSeconds })
      });

      const resData = await response.json();
      if (response.ok) {
        showConsoleLog(
          'gameConsoleLog', 
          `Round Seeded! Answer: "${correctAnswer}" | Points: ${points} | Mode: ${isActive ? 'Active' : 'Expired'}`, 
          'success'
        );
      } else {
        showConsoleLog('gameConsoleLog', `Seeding Failed: ${resData.error}`, 'error');
      }
    } catch (err) {
      showConsoleLog('gameConsoleLog', `Network error while seeding round: ${err.message}`, 'error');
    }
  }

  // 6. Submit Quiz Answer
  async function submitQuizAnswer(e) {
    e.preventDefault();
    const gameId = txtGameId.value.trim();
    const roundId = txtRoundId.value.trim();
    const playerId = txtGamePlayerId.value.trim();
    const answer = txtAnswer.value.trim();

    showConsoleLog('gameConsoleLog', `Submitting answer "${answer}" for ${playerId}...`, 'info');

    try {
      const response = await fetch('/api/game/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, roundId, playerId, answer })
      });

      const data = await response.json();

      if (response.status === 200) {
        showConsoleLog(
          'gameConsoleLog', 
          `Success! Submission recorded. Player score is now ${data.newScore}`, 
          'success'
        );
        // Put player in search box and look up automatically
        txtSearchPlayerId.value = playerId;
        searchedPlayerId = playerId;
        fetchPlayerStats(playerId);
      } else if (response.status === 400 && data.code === 'DUPLICATE_SUBMISSION') {
        showConsoleLog(
          'gameConsoleLog', 
          `Rejected: DUPLICATE_SUBMISSION - Player ${playerId} already submitted an answer for this round.`, 
          'error'
        );
      } else if (response.status === 403 && data.code === 'ROUND_EXPIRED') {
        showConsoleLog(
          'gameConsoleLog', 
          `Rejected: ROUND_EXPIRED - The submission window for round ${roundId} has closed.`, 
          'error'
        );
      } else {
        showConsoleLog('gameConsoleLog', `Failed: ${data.error || data.code || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showConsoleLog('gameConsoleLog', `Network error during submission: ${err.message}`, 'error');
    }
  }

  // 7. Admin: Get Active Sessions
  async function fetchUserSessions() {
    const userId = txtAdminUserId.value.trim();
    if (!userId) return;

    sessionsResults.innerHTML = `
      <div class="display-empty">
        <i class="fa-solid fa-spinner fa-spin"></i>
        <p>Fetching active user sessions from Redis...</p>
      </div>
    `;

    try {
      const response = await fetch(`/api/admin/sessions/user/${encodeURIComponent(userId)}`);
      if (!response.ok) throw new Error('Fetch sessions failed');
      const sessions = await response.json();

      if (sessions.length === 0) {
        sessionsResults.innerHTML = `
          <div class="display-empty">
            <i class="fa-solid fa-face-meh"></i>
            <p>No active sessions found for user <strong>${escapeHtml(userId)}</strong>.</p>
          </div>
        `;
        return;
      }

      sessionsResults.innerHTML = '';
      sessions.forEach(sess => {
        const item = document.createElement('div');
        item.className = 'session-item';
        
        let deviceIcon = '<i class="fa-solid fa-desktop"></i>';
        if (sess.deviceType === 'mobile') deviceIcon = '<i class="fa-solid fa-mobile-screen"></i>';
        else if (sess.deviceType === 'tablet') deviceIcon = '<i class="fa-solid fa-tablet-screen-button"></i>';

        item.innerHTML = `
          <div class="session-detail">
            <span class="session-id">${sess.sessionId}</span>
            <div class="session-meta">
              <span>${deviceIcon} ${sess.deviceType}</span>
              <span><i class="fa-solid fa-network-wired"></i> ${sess.ipAddress}</span>
            </div>
          </div>
          <button class="btn btn-danger btn-sm btn-invalidate-session" data-id="${sess.sessionId}">
            <i class="fa-solid fa-trash-can"></i> Invalidate
          </button>
        `;
        sessionsResults.appendChild(item);
      });

      // Hook up Invalidate buttons
      sessionsResults.querySelectorAll('.btn-invalidate-session').forEach(btn => {
        btn.addEventListener('click', async () => {
          const sid = btn.dataset.id;
          btn.disabled = true;
          btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
          await invalidateSession(sid);
        });
      });
    } catch (err) {
      console.error(err);
      sessionsResults.innerHTML = `
        <div class="display-empty" style="color: var(--red);">
          <i class="fa-solid fa-circle-exclamation"></i>
          <p>Failed to query sessions.</p>
        </div>
      `;
    }
  }

  // 8. Admin: Invalidate Session
  async function invalidateSession(sessionId) {
    try {
      const response = await fetch(`/api/admin/sessions/${sessionId}`, {
        method: 'DELETE'
      });
      if (response.ok || response.status === 204) {
        // Refresh session list
        fetchUserSessions();
      } else {
        alert('Failed to invalidate session');
        fetchUserSessions();
      }
    } catch (err) {
      console.error(err);
      alert('Error connecting to backend API');
      fetchUserSessions();
    }
  }

  // 9. Admin: Register Session
  async function registerUserSession(e) {
    e.preventDefault();
    const userId = txtNewSessionUserId.value.trim();
    const ipAddress = txtNewSessionIp.value.trim();
    const deviceType = selNewSessionDevice.value;

    showConsoleLog('sessionCreateLog', 'Creating session and invalidating older ones...', 'info');

    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ipAddress, deviceType })
      });

      const data = await response.json();
      if (response.status === 201) {
        showConsoleLog('sessionCreateLog', `Session Created! ID: ${data.sessionId}. Old user sessions invalidated atomically.`, 'success');
        
        // Sync User ID inputs and refresh sessions list
        txtAdminUserId.value = userId;
        fetchUserSessions();
      } else {
        showConsoleLog('sessionCreateLog', `Error: ${data.error}`, 'error');
      }
    } catch (err) {
      showConsoleLog('sessionCreateLog', `Network error creating session: ${err.message}`, 'error');
    }
  }

  // ----------------------------------------------------
  // Helpers
  // ----------------------------------------------------
  
  function showConsoleLog(elementId, msg, type = 'info') {
    const el = document.getElementById(elementId);
    el.classList.remove('hidden');
    el.innerHTML = `<span class="log-${type}">[${new Date().toLocaleTimeString()}] ${escapeHtml(msg)}</span>`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
});
