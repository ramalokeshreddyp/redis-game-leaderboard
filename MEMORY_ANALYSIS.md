# Redis Memory Analysis Report

This report documents the memory footprint, structural encodings, and performance implications of using Redis Hashes for session management and Sorted Sets (ZSets) for game leaderboards.

---

## 1. Memory Footprint of Core Structures

Using our benchmarking script, we measured the actual memory footprint of a single user session Hash and a global leaderboard with 100,000 active players.

### A. User Session Hash
A user session is modeled as a Redis Hash storing fields: `userId`, `createdAt`, `lastActive`, `ipAddress`, and `deviceType`.

*   **Key**: `session:memory_test`
*   **Object Encoding**: `listpack` (previously known as `ziplist` in Redis versions < 7.0)
*   **Memory Usage**: **256 bytes**

> [!NOTE]
> Since the fields and values in a session hash are small, Redis uses the `listpack` encoding, which stores the hash as a single, contiguous, highly compact byte array. This yields a tiny memory footprint.

### B. Global Leaderboard (100,000 Players)
The global leaderboard is modeled as a single Sorted Set containing 100k players and their numeric scores.

*   **Key**: `leaderboard:memory_test`
*   **Object Encoding**: `skiplist`
*   **Memory Usage**: **9,049,392 bytes (8.63 MB)**
*   **Average Footprint per Player**: ~90.5 bytes

> [!NOTE]
> When the number of elements in a Sorted Set exceeds the default limit of 128, Redis automatically converts its encoding from `listpack` to a dual structure consisting of a **Skip List** and a **Hash Table**.

---

## 2. Structural Encoding Comparison: Listpack vs. Skiplist

To understand the memory overhead of the Skip List structure, we compared the memory footprint of a Sorted Set containing **1,000 players** under two configurations:
1.  **Listpack Enabled**: Configured `zset-max-listpack-entries` to `2000` (allowing all 1,000 elements to fit in a listpack).
2.  **Skiplist Forced**: Configured `zset-max-listpack-entries` to `0` (forcing the 1,000 elements to be encoded as a skiplist).

### Encoding & Memory Usage Comparison (1,000 players)

| Configuration | Object Encoding (`OBJECT ENCODING`) | Memory Usage (`MEMORY USAGE`) | Avg. Bytes per Player |
| :--- | :--- | :--- | :--- |
| **Listpack (Default / ZipList)** | `listpack` | **16,448 bytes (16.06 KB)** | 16.4 bytes |
| **Skiplist (Forced)** | `skiplist` | **89,000 bytes (86.91 KB)** | 89.0 bytes |

### Key Findings & Analysis
*   **Memory Inflation**: Switching from `listpack` to `skiplist` increased memory usage by **72,552 bytes (+441.10%)**. The skiplist encoding consumes **5.41 times** more memory than the compact listpack representation for the same 1,000 records.
*   **Why is Listpack so efficient?**
    *   **Contiguous Memory Allocation**: A listpack is a single block of contiguous memory. It has no pointer overhead or node-allocation overhead.
    *   **No Pointers**: Elements are packed back-to-back, using variable-length integer encoding to save space.
*   **Why does Skiplist consume so much memory?**
    *   **Pointer Overhead**: Each node in a skiplist has a forward pointer array (up to 32 levels, average ~1.58 pointers per node). On a 64-bit system, each pointer is 8 bytes.
    *   **Dual Data Structure**: Redis ZSets are backed by *both* a Skip List (for range queries) and a Dict/Hash Table (for O(1) score lookup of a member). This means every element is double-indexed.
    *   **Memory Fragmentation**: Each player addition requires separate heap allocations for the dict entry and the skiplist node, leading to allocation padding (typically 8-byte boundaries) and memory fragmentation.

---

## 3. Production Recommendation

1.  **Leave Defaults in Place**: Do not set `zset-max-listpack-entries` to `0` in production. The default value of `128` is a sweet spot.
2.  **Fine-Tuning**: If you have many small, short-lived game rooms/leaderboards (e.g. 50-200 players), you can increase `zset-max-listpack-entries` to `256` or `512` to ensure they remain encoded in `listpack`, saving substantial memory across millions of small rooms. However, keep in mind that search/insert operations in a listpack are `O(N)` (linear scan), so keeping N under 512 prevents CPU bottlenecks.
