# PulseBoard: Redis-Powered Real-Time Game Leaderboard

A high-performance, real-time competitive game leaderboard and session manager. Built with **Node.js (Express)** and **Redis 7 (alpine)**, containerized with **Docker**, and leveraging **Lua scripting** for atomic operations and **Server-Sent Events (SSE)** for instant UI propagation.

---

## Architecture Overview

PulseBoard comprises three main components:
1.  **Frontend Dashboard**: A responsive, vanilla HTML5/JS/CSS client that connects to the API and displays the global leaderboard, player standing, and active session details. It subscribes to an SSE channel for real-time score updates.
2.  **API Application Server**: An Express.js backend that handles user requests, interacts with Redis via `ioredis` (including executing pre-cached Lua scripts), and broadcasts event messages.
3.  **Redis In-Memory Store**: Handles session objects (Hashes), active session indexes (Sets), the global leaderboard (Sorted Sets), round submissions (Sets), round configuration (Hashes), and real-time messaging (Pub/Sub).

```
   +-----------------------------------------------------------+
   |                    Browser Client (UI)                    |
   +-----+----------------------+------------------------------+
         |                      ^              ^
         | HTTP REST Requests   | EventSource  |
         | (Login, Answers)     | (/api/events)| SSE Updates
         v                      |              |
   +-----+----------------------+--------------+---------------+
   |                      Game API Server                      |
   +-----+----------------------+------------------------------+
         |                      |              ^
         | ioredis Commands     | PUBLISH      | SUBSCRIBE
         | (Hashes, ZSets, Lua) | game:events  | game:events
         v                      v              |
   +----------------------------+--------------+---------------+
   |                        Redis Server                       |
   +-----------------------------------------------------------+
```

---

## Redis Key Schema Design

We adopt the `object-type:id:field` convention to organize Redis keys:

| Data Type | Key Pattern | Example Key | Description |
| :--- | :--- | :--- | :--- |
| **Session Hash** | `session:{sessionId}` | `session:d2f4...` | A Hash containing user session data (`userId`, `ipAddress`, `deviceType`, `createdAt`, `lastActive`). Has a 30-min TTL. |
| **User Sessions Index** | `user_sessions:{userId}` | `user_sessions:42` | A Set containing all active session IDs for the user. Used for session invalidation. |
| **Global Leaderboard** | `leaderboard:global` | `leaderboard:global` | A Sorted Set (ZSet) storing all player IDs sorted by their total scores. |
| **Game Round State** | `game_round:{gameId}:{roundId}` | `game_round:g-501:r-3` | A Hash containing round configurations (`correctAnswer`, `points`, `endTime`). |
| **Round Submissions** | `submissions:{gameId}:{roundId}` | `submissions:g-501:r-3` | A Set storing player IDs who have submitted answers for this round. Prevents duplicate submissions. |

---

## Detailed Lua Scripts and Atomic Operations

Many operations in a real-time system require multiple sequential steps (e.g. read value -> check condition -> update state). If multiple clients execute these concurrently, race conditions and inconsistent states occur. 
To guarantee absolute data integrity, PulseBoard uses **atomic Lua scripting (`EVAL`)** for two critical operations:

### 1. Atomic Session Login and Invalidation (`initializeSession`)
*   **Location**: Defined inside `server.js` and loaded on start.
*   **Keys**: `KEYS[1] = user_sessions:{userId}`, `KEYS[2] = session:{sessionId}`
*   **Goal**: Ensure a user has at most one active session at a time.
*   **Rationale for Lua**:
    Without Lua, a client would fetch active sessions from the Set, iterate through each and delete them, then create the new session and write to the Set. If two login requests for the same user occur concurrently:
    1. Both read the existing sessions at the same time.
    2. Both proceed to delete them.
    3. Both register their respective new sessions.
    This can leave both sessions active or leak old keys in Redis.
    **Lua execution is single-threaded and block-exclusive inside Redis**, guaranteeing that the fetch, bulk delete, clear, and new registration happen as a single, indivisible step. No other command can run in between.

### 2. Atomic Quiz Answer Processor (`submitQuizAnswer`)
*   **Location**: Defined inside `server.js`.
*   **Keys**: `KEYS[1] = game_round:{gameId}:{roundId}`, `KEYS[2] = submissions:{gameId}:{roundId}`, `KEYS[3] = leaderboard:global`
*   **Goal**: Atomically submit a player's answer, validating the round expiration and preventing duplicates.
*   **Lua Logic**:
    1. Read the round's `endTime` and compare it with the current timestamp. If `currentTime >= endTime`, return `["ERROR", "ROUND_EXPIRED"]`.
    2. Query `SISMEMBER` on the round's submission Set. If the player has already submitted, return `["ERROR", "DUPLICATE_SUBMISSION"]`.
    3. Add the player to the submission Set (`SADD`).
    4. Fetch `correctAnswer` and `points` from the round Hash. If the submitted answer is correct, increment the player's score on `leaderboard:global` using `ZINCRBY`. If incorrect, fetch the current score using `ZSCORE` without updating.
    5. Return `["SUCCESS", newScore, scoreUpdated]`.
*   **Rationale for Lua**:
    If a player submits their answer multiple times in rapid succession (e.g., clicking the button twice), standard HTTP handlers might process both requests in parallel. If we did not use Lua, two concurrent processes could both check `SISMEMBER` (both find it is false), and both proceed to increment the score, awarding double points for a single answer. By consolidating all checks and updates inside a single Lua script, Redis guarantees that only the first request records a submission and awards points, while the second request is immediately rejected as a duplicate.

---

## Setup & Running the Application

### Prerequisites
*   [Docker Desktop](https://www.docker.com/products/docker-desktop/) (ensure it is running)
*   [Docker Compose](https://docs.docker.com/compose/)

### Quick Start
1.  Clone this repository (or place files in your directory).
2.  Run the services using a single command:
    ```bash
    docker-compose up -d --build
    ```
3.  Wait until the containers are started and healthy.
4.  Open your browser and navigate to:
    ```
    http://localhost:3000
    ```
    You will be greeted by the **PulseBoard Dashboard**!

---

## API Endpoints

### 1. Health Check
*   `GET /health`
*   Returns `200 OK` if the server and Redis are up:
    ```json
    { "status": "OK", "redis": "CONNECTED" }
    ```

### 2. User Session Management
*   `POST /api/sessions`
    Creates a new user session and invalidates any existing active sessions.
    *   **Body**:
        ```json
        { "userId": "user-abc", "ipAddress": "192.168.1.1", "deviceType": "desktop" }
        ```
    *   **Response (201 Created)**:
        ```json
        { "sessionId": "824b2670-b74a-49eb-83b6-9bb5ab6a0c5c" }
        ```

### 3. Global Leaderboard
*   `POST /api/leaderboard/scores`
    Directly submits or increments a player's score (atomic ZINCRBY).
    *   **Body**:
        ```json
        { "playerId": "player-1", "points": 10 }
        ```
    *   **Response (200 OK)**:
        ```json
        { "playerId": "player-1", "newScore": 10 }
        ```

*   `GET /api/leaderboard/top/:count`
    Returns the top player list.
    *   **Response (200 OK)**:
        ```json
        [
          { "rank": 1, "playerId": "player-1", "score": 100 }
        ]
        ```

*   `GET /api/leaderboard/player/:playerId`
    Gets a player's score, rank, percentile standing, and nearby rivals.
    *   **Response (200 OK)**:
        ```json
        {
          "playerId": "player-alpha",
          "score": 100,
          "rank": 10,
          "percentile": 95.5,
          "nearbyPlayers": {
            "above": [{ "rank": 9, "playerId": "player-beta", "score": 102 }],
            "below": [{ "rank": 11, "playerId": "player-gamma", "score": 98 }]
          }
        }
        ```

### 4. Game Round Submissions
*   `POST /api/game/submit`
    Atomically validates round state, submission uniqueness, and calculates score increments.
    *   **Body**:
        ```json
        { "gameId": "g-501", "roundId": "r-3", "playerId": "player-alpha", "answer": "A" }
        ```
    *   **Response (200 OK)**:
        ```json
        { "status": "SUCCESS", "newScore": 123 }
        ```
    *   **Error Responses**:
        *   `400 Bad Request`: `{ "status": "ERROR", "code": "DUPLICATE_SUBMISSION" }`
        *   `403 Forbidden`: `{ "status": "ERROR", "code": "ROUND_EXPIRED" }`

### 5. Server-Sent Events (SSE)
*   `GET /api/events`
    Long-lived connection that streams live game event broadcasts.
    *   **Event Format**:
        ```
        event: leaderboard_updated
        data: {"playerId":"player-alpha","newScore":75}
        ```

### 6. Admin Endpoints
*   `GET /api/admin/sessions/user/:userId`
    Returns all active session hashes registered under the user ID.
    *   **Response (200 OK)**:
        ```json
        [
          { "sessionId": "...", "ipAddress": "192.168.1.1", "deviceType": "desktop" }
        ]
        ```

*   `DELETE /api/admin/sessions/:sessionId`
    Invalidates and deletes a specific session hash and removes it from the user set.
    *   **Response (204 No Content)**

*   `POST /api/admin/rounds`
    Utility endpoint to configure a mock round for interactive UI testing.
    *   **Body**:
        ```json
        { "gameId": "g-501", "roundId": "r-3", "correctAnswer": "A", "points": 15, "durationSeconds": 60 }
        ```
    *   **Response (201 Created)**

---

## Memory Analysis & Benchmarking

To run the memory benchmark and seed 100,000 players:
1. Make sure your Docker container `game_api` is running.
2. Execute the seeding script inside the container:
   ```bash
   docker exec game_api node scripts/seed_memory_test.js
   ```
For detailed results, see the [MEMORY_ANALYSIS.md](MEMORY_ANALYSIS.md) file.
