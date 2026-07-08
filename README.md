# ⚡ PulseBoard: Redis-Powered Real-Time Game Leaderboard & Session Store

PulseBoard is a high-performance, real-time leaderboard and user session management engine built for competitive quiz platforms. It demonstrates the power of Redis beyond simple caching by leveraging server-side Hashes, Sorted Sets, and Sets, ensuring concurrency safety via pre-cached Lua scripts, and distributing instant updates using a Redis Pub/Sub to Server-Sent Events (SSE) pipeline.

---

## 🏗️ System Architecture & Execution Flows

### 1. Unified System Overview
```mermaid
graph TD
    %% Styling
    classDef client fill:#3498db,stroke:#2980b9,stroke-width:2px,color:#fff;
    classDef server fill:#9b59b6,stroke:#8e44ad,stroke-width:2px,color:#fff;
    classDef database fill:#e74c3c,stroke:#c0392b,stroke-width:2px,color:#fff;
    
    subgraph UI ["Client Layer"]
        C[Web Dashboard]:::client
    end
    
    subgraph App ["Application Layer"]
        API[Express.js Server]:::server
        SSE[SSE Event Stream]:::server
    end
    
    subgraph Cache ["Data & Messaging Layer (Redis)"]
        Hash[Session Hashes]:::database
        Set[Session Sets]:::database
        ZSet[Global Leaderboard ZSet]:::database
        PubSub[Pub/Sub Engine]:::database
    end
    
    C -->|1. HTTP REST Calls| API
    API -->|2. Exec Lua / ZINCRBY| ZSet
    API -->|3. HSET / DEL| Hash
    API -->|4. SADD / SREM| Set
    API -->|5. PUBLISH game:events| PubSub
    PubSub -->|6. Broadcast| SSE
    SSE -->|7. PUSH Stream| C
```

### 2. Session Creation & Atomic Invalidation Flow
When a user logs in, older sessions must be invalidated atomically using a Lua script to prevent race conditions.

```mermaid
sequenceDiagram
    autonumber
    actor Player as Web Client
    participant Express as API Server
    participant Lua as Redis Lua Engine
    participant Session as session:{sessionId} Hash
    participant UserIdx as user_sessions:{userId} Set

    Player->>Express: POST /api/sessions { userId, ipAddress, deviceType }
    Note over Express: Generates new UUID sessionId
    Express->>Lua: EVAL initializeSession (user_sessions:{userId}, session:{sessionId})
    
    activate Lua
    Lua->>UserIdx: SMEMBERS (get all active sessionIds for user)
    loop For each old sessionId
        Lua->>Session: DEL session:{oldSessionId}
    end
    Lua->>UserIdx: DEL (clear old sessions set)
    Lua->>Session: HSET (register new session info)
    Lua->>Session: EXPIRE (set 30 min TTL)
    Lua->>UserIdx: SADD (add new sessionId)
    Lua->>UserIdx: EXPIRE (set 30 min TTL)
    Lua-->>Express: Return Success (1)
    deactivate Lua
    
    Express-->>Player: 201 Created { sessionId }
```

### 3. Atomic Quiz Answer Submission & Propagation Flow
Handles checking round state, enforcing duplicate prevention, updating scores, and pushing live events.

```mermaid
sequenceDiagram
    autonumber
    actor Player as Web Client
    participant Express as API Server
    participant Lua as Redis Lua Engine
    participant Round as game_round:{gameId}:{roundId} Hash
    participant Sub as submissions:{gameId}:{roundId} Set
    participant ZSet as leaderboard:global ZSet
    participant PubSub as Redis Pub/Sub
    participant SSE as SSE Stream (Other Clients)

    Player->>Express: POST /api/game/submit { gameId, roundId, playerId, answer }
    Express->>Lua: EVAL submitQuizAnswer (roundKey, submissionsKey, globalLeaderboardKey)
    
    activate Lua
    Lua->>Round: HGET endTime
    alt Current Time >= endTime
        Lua-->>Express: Return {"ERROR", "ROUND_EXPIRED"}
    end
    
    Lua->>Sub: SISMEMBER playerId
    alt Already Submitted (is_member == 1)
        Lua-->>Express: Return {"ERROR", "DUPLICATE_SUBMISSION"}
    end
    
    Lua->>Sub: SADD playerId
    Lua->>Round: HGET correctAnswer & points
    alt submittedAnswer == correctAnswer
        Lua->>ZSet: ZINCRBY (increment points)
        Note over Lua: scoreUpdated = 1
    else
        Lua->>ZSet: ZSCORE (get current score)
        Note over Lua: scoreUpdated = 0
    end
    Lua-->>Express: Return {"SUCCESS", newScore, scoreUpdated}
    deactivate Lua

    alt Status == SUCCESS
        Express-->>Player: 200 OK { status: "SUCCESS", newScore }
        alt scoreUpdated == 1
            Express->>PubSub: PUBLISH game:events { event: "leaderboard_updated", data }
            PubSub->>SSE: Broadcast message
            SSE->>Player: PUSH Event "leaderboard_updated" (Real-time updates)
        end
    else status == ERROR
        alt Code == ROUND_EXPIRED
            Express-->>Player: 403 Forbidden { status: "ERROR", code: "ROUND_EXPIRED" }
        else Code == DUPLICATE_SUBMISSION
            Express-->>Player: 400 Bad Request { status: "ERROR", code: "DUPLICATE_SUBMISSION" }
        end
    end
```

---

## 🛠️ Technology Stack

*   **Runtime**: [Node.js (v20-alpine)](https://nodejs.org/)
*   **Web Framework**: [Express.js](https://expressjs.com/)
*   **Database**: [Redis 7 (alpine)](https://redis.io/)
*   **Redis Client**: [ioredis](https://github.com/redis/ioredis)
*   **Containerization**: [Docker](https://www.docker.com/) & [Docker Compose](https://docs.docker.com/compose/)
*   **Frontend**: Vanilla HTML5, CSS3 (Glassmorphism, custom micro-animations), and Vanilla JavaScript (using `EventSource` for SSE).

---

## 📁 Code Structure & Organization

```
redis-game-leaderboard/
│
├── .env                  # Running configuration variables (ignored by git)
├── .env.example          # Template documenting environment variables
├── Dockerfile            # Multi-stage Docker setup for api service
├── docker-compose.yml    # Main orchestration stack (api + redis services)
├── package.json          # Dependencies & npm scripts
├── server.js             # Core Express server & Redis Lua loading logic
│
├── public/               # Client-side web dashboard code
│   ├── index.html        # Glassmorphic single page dashboard
│   ├── css/
│   │   └── style.css     # Dark mode CSS with glowing highlights & transitions
│   └── js/
│       └── app.js        # SSE listeners, DOM updates, & API controllers
│
├── scripts/
│   └── seed_memory_test.js  # Seeding tool & memory analysis benchmark runner
│
├── MEMORY_ANALYSIS.md    # Findings on listpack vs skiplist encoding
├── README.md             # This highly attractive system overview
├── architecture.md       # High-level architecture documentation
├── projectdocumentation.md  # Detailed system objective and specs
└── submission.json       # Config file containing evaluator test credentials
```

---

## 🚀 Setup & Installation Steps

Follow these steps to run the application locally from scratch:

### 1. Clone & Configure
Clone this project to your local directory.
Copy the environment variables template:
```bash
cp .env.example .env
```
Ensure the default variables in `.env` are set:
```env
REDIS_URL=redis://redis:6379
API_PORT=3000
```

### 2. Run with Docker Compose
Ensure Docker Desktop is open and active, then run:
```bash
docker-compose up -d --build
```
This builds the application image, downloads Redis alpine, configures mutual health checks, and starts the services.

Verify that both containers are healthy:
```bash
docker ps
```
The status should display `Up X seconds (healthy)`.

---

## 💻 Local Execution & Usage Instructions

### 1. Access the Dashboard
Once the containers are running, navigate to:
```
http://localhost:3000
```
This loads the single-page application. The status indicator at the top right will glow green and read `Live Stream Connected` when the SSE pipeline is active.

### 2. Interactive Seeding & Playing
You can test the entire system flow using the widgets on the dashboard:
*   **Seed Game Round**: Click `Active (60s)` to create a round (`r-3`) that is open for submissions, or click `Expired` to create one that is closed.
*   **Quiz Console**: Submit answers for players (e.g. Player `player-1` submits `A`). Correct answers will immediately trigger a score increase on the board.
*   **Live Updates**: Watch the dashboard. When a score updates, an SSE event is caught, adding a message to the scrolling **Live Feed ticker** at the top, and highlighting the updated row in the leaderboard with a green pulse animation.
*   **Player Performance Finder**: Search for a player ID to view their rank, score, calculated percentile standing, and a list of rivals directly above and below them.
*   **Admin Session Manager**: Register a session (which invalidates old sessions for that user) and view/delete sessions live in Redis.

---

## 📊 Run Benchmarking & Memory Tests
To replicate the listpack/skiplist memory analysis and seed 100k test records into your local Redis database:
```bash
docker exec game_api node scripts/seed_memory_test.js
```
The results and explanation can be viewed in [MEMORY_ANALYSIS.md](MEMORY_ANALYSIS.md).
