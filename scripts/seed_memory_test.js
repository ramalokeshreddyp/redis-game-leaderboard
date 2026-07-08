const Redis = require('ioredis');

async function run() {
  const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  console.log(`Connected to Redis at ${process.env.REDIS_URL || 'localhost:6379'} for memory analysis...`);

  try {
    // ----------------------------------------------------------------
    // 1. Clean up previous test keys
    // ----------------------------------------------------------------
    await redis.del('leaderboard:memory_test', 'session:memory_test', 'leaderboard:compare');

    // ----------------------------------------------------------------
    // 2. Measure Session Hash Memory Usage
    // ----------------------------------------------------------------
    console.log('\n--- Session Hash Memory Analysis ---');
    const sessionKey = 'session:memory_test';
    await redis.hset(sessionKey, {
      userId: 'test-user-for-eval-12345',
      createdAt: new Date().toISOString(),
      lastActive: new Date().toISOString(),
      ipAddress: '192.168.1.100',
      deviceType: 'desktop'
    });
    await redis.expire(sessionKey, 1800);

    const hashMem = await redis.send_command('MEMORY', ['USAGE', sessionKey]);
    const hashEnc = await redis.object('ENCODING', sessionKey);
    console.log(`Hash Key: ${sessionKey}`);
    console.log(`Hash Encoding: ${hashEnc}`);
    console.log(`Hash Memory Usage: ${hashMem} bytes`);

    // ----------------------------------------------------------------
    // 3. Seed 100k Players into Sorted Set
    // ----------------------------------------------------------------
    console.log('\n--- Seeding 100k players into Global Leaderboard (Sorted Set) ---');
    console.time('Seeding 100k players');
    
    // Seed in batches of 1000 to maximize performance
    const batchSize = 1000;
    let pipeline = redis.pipeline();
    
    for (let i = 1; i <= 100000; i++) {
      const score = Math.floor(Math.random() * 100000);
      pipeline.zadd('leaderboard:memory_test', score, `player-${i}`);
      
      if (i % batchSize === 0) {
        await pipeline.exec();
        pipeline = redis.pipeline();
      }
    }
    console.timeEnd('Seeding 100k players');

    const zsetMem = await redis.send_command('MEMORY', ['USAGE', 'leaderboard:memory_test']);
    const zsetEnc = await redis.object('ENCODING', 'leaderboard:memory_test');
    console.log(`100k ZSet Key: leaderboard:memory_test`);
    console.log(`100k ZSet Encoding: ${zsetEnc}`);
    console.log(`100k ZSet Memory Usage: ${(zsetMem / 1024 / 1024).toFixed(2)} MB (${zsetMem} bytes)`);

    // ----------------------------------------------------------------
    // 4. Comparison: Listpack vs Skiplist
    //    We will seed 1000 players under default and modified configs.
    // ----------------------------------------------------------------
    console.log('\n--- Comparing ZSet Encoding (Listpack vs Skiplist) with 1,000 players ---');
    
    // Check which configuration parameter is available in Redis 7 (listpack is used instead of ziplist)
    let configParam = 'zset-max-listpack-entries';
    try {
      await redis.config('GET', configParam);
    } catch (e) {
      configParam = 'zset-max-ziplist-entries';
    }
    console.log(`Using config parameter: ${configParam}`);

    // A. Listpack configuration (default config, zset-max-listpack-entries = 128, but let's set to 2000 so 1000 items stay in listpack)
    await redis.config('SET', configParam, '2000');
    await redis.del('leaderboard:compare');

    for (let i = 1; i <= 1000; i++) {
      await redis.zadd('leaderboard:compare', i * 10, `player-${i}`);
    }

    const listpackMem = await redis.send_command('MEMORY', ['USAGE', 'leaderboard:compare']);
    const listpackEnc = await redis.object('ENCODING', 'leaderboard:compare');

    console.log('\n[Listpack Configuration]');
    console.log(`Encoding: ${listpackEnc}`);
    console.log(`Memory Usage (1,000 players): ${listpackMem} bytes`);

    // B. Skiplist configuration (set zset-max-listpack-entries = 0 to force skiplist)
    await redis.config('SET', configParam, '0');
    
    // Add one more element to trigger conversion, or delete and recreate. Let's delete and recreate to see the difference clearly.
    await redis.del('leaderboard:compare');
    for (let i = 1; i <= 1000; i++) {
      await redis.zadd('leaderboard:compare', i * 10, `player-${i}`);
    }

    const skiplistMem = await redis.send_command('MEMORY', ['USAGE', 'leaderboard:compare']);
    const skiplistEnc = await redis.object('ENCODING', 'leaderboard:compare');

    console.log('\n[Skiplist Configuration]');
    console.log(`Encoding: ${skiplistEnc}`);
    console.log(`Memory Usage (1,000 players): ${skiplistMem} bytes`);

    // C. Calculate savings
    const diffBytes = skiplistMem - listpackMem;
    const pctIncrease = ((diffBytes / listpackMem) * 100).toFixed(2);
    console.log(`\nDifference: Skiplist uses ${diffBytes} more bytes (+${pctIncrease}%)`);

    // Restore default configuration
    await redis.config('SET', configParam, '128');
    console.log(`\nRestored ${configParam} to default (128).`);

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await redis.quit();
  }
}

run();
