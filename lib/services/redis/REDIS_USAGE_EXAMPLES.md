# Redis Cache Service Usage Examples

## Configuration

Add your Redis Cloud connection URL to `.env`:

```env
# Redis Cloud Configuration
# Get this URL from your Redis Cloud dashboard
# Format: redis[s]://[[username][:password]@]host[:port][/db]
REDIS_URL=rediss://default:yourpassword@your-endpoint.redis.com:16379/0
```

Redis Cloud provides this URL directly in your database dashboard. Simply copy and paste it into your `.env` file.

## Basic Usage in Routes

### 1. Caching API Responses

```typescript
import { cacheService, CacheTTL } from "../../services/redis";
// Or if importing from outside the services folder:
// import { cacheService, CacheTTL } from "../services/redis";

// In your route handler
public static getProjects = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user._id;
  const cacheKey = `projects:${userId}`;

  // Try to get from cache
  const cached = await cacheService.get(cacheKey);
  if (cached) {
    return SuccessResponse(res, 200, {
      message: "Projects retrieved from cache",
      data: cached
    });
  }

  // If not cached, fetch from database
  const projects = await ProjectModel.find({ userId });

  // Cache the result
  await cacheService.set(cacheKey, projects, { ttl: CacheTTL.MEDIUM });

  return SuccessResponse(res, 200, {
    message: "Projects retrieved",
    data: projects
  });
};
```

### 2. Using getOrSet Pattern

```typescript
// Simplified caching with getOrSet
public static getCompanyDetails = async (req: AuthenticatedRequest, res: Response) => {
  const { companyId } = req.params;

  const company = await cacheService.getOrSet(
    `company:${companyId}`,
    async () => {
      // This function is only called if cache miss
      return await CompanyModel.findById(companyId).populate('members');
    },
    { ttl: CacheTTL.LONG }
  );

  return SuccessResponse(res, 200, {
    message: "Company details",
    data: company
  });
};
```

### 3. Session Management

```typescript
// Store user session
await cacheService.setUserSession(userId, {
  lastActivity: Date.now(),
  deviceId: req.headers['device-id'],
  permissions: user.permissions
});

// Get user session
const session = await cacheService.getUserSession(userId);

// Delete user session (on logout)
await cacheService.deleteUserSession(userId);
```

### 4. Rate Limiting

```typescript
public static createPost = async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user._id;

  // Check rate limit: 10 posts per minute
  const rateLimit = await cacheService.checkRateLimit(
    `post:create:${userId}`,
    10, // limit
    60  // window in seconds
  );

  if (!rateLimit.allowed) {
    return ErrorResponse(res, 429, {
      message: `Rate limit exceeded. ${rateLimit.remaining} requests remaining`
    });
  }

  // Proceed with post creation
  // ...
};
```

### 5. Cache Invalidation

```typescript
// When a project is updated, invalidate related caches
public static updateProject = async (req: AuthenticatedRequest, res: Response) => {
  const { projectId } = req.params;
  const userId = req.user._id;

  // Update in database
  const project = await ProjectModel.findByIdAndUpdate(projectId, req.body);

  // Invalidate specific caches
  await cacheService.delete(`project:${projectId}`);
  await cacheService.delete(`projects:${userId}`);

  // Or invalidate all project-related caches
  await cacheService.deletePattern(`project:*`);

  return SuccessResponse(res, 200, {
    message: "Project updated",
    data: project
  });
};
```

### 6. Distributed Locking

```typescript
// Prevent concurrent operations
public static processPayment = async (req: AuthenticatedRequest, res: Response) => {
  const { orderId } = req.params;
  const lockKey = `payment:${orderId}`;

  // Try to acquire lock
  const lockAcquired = await cacheService.acquireLock(lockKey, 30); // 30 second lock

  if (!lockAcquired) {
    return ErrorResponse(res, 409, {
      message: "Payment already being processed"
    });
  }

  try {
    // Process payment
    await processPaymentLogic(orderId);

    return SuccessResponse(res, 200, {
      message: "Payment processed"
    });
  } finally {
    // Always release lock
    await cacheService.releaseLock(lockKey);
  }
};
```

### 7. Batch Operations

```typescript
// Cache multiple items at once
const posts = await PostModel.find({ projectId });
const cacheItems = posts.map(post => ({
  key: `post:${post._id}`,
  value: post,
  ttl: CacheTTL.MEDIUM
}));

await cacheService.mset(cacheItems);

// Get multiple items at once
const postIds = ['id1', 'id2', 'id3'];
const keys = postIds.map(id => `post:${id}`);
const cachedPosts = await cacheService.mget(keys);
```

## Integration with Existing Services

### Example: Caching S3 Presigned URLs

```typescript
// In awsBucket.ts service
import { cacheService } from "./redis";

class FileService {
  // ... existing code ...

  public getPresignedUrl = async (key: string): Promise<string> => {
    const cacheKey = `presigned:${key}`;

    // Check cache first
    const cached = await cacheService.get<string>(cacheKey);
    if (cached) {
      return cached;
    }

    // Generate new presigned URL
    const url = await this.generatePresignedUrl(key);

    // Cache for 50 minutes (URLs expire in 60 minutes)
    await cacheService.set(cacheKey, url, { ttl: 3000 });

    return url;
  };
}
```

### Example: Caching Database Aggregations

```typescript
// In project report service
public static generateReport = async (projectId: string) => {
  return await cacheService.getOrSet(
    `report:${projectId}`,
    async () => {
      // Expensive aggregation
      const report = await ProjectModel.aggregate([
        { $match: { _id: projectId } },
        // ... complex aggregation pipeline
      ]);
      return report;
    },
    { ttl: CacheTTL.LONG }
  );
};
```

## Monitoring and Maintenance

### Get Cache Statistics

```typescript
// Admin endpoint to check cache stats
public static getCacheStats = async (req: Request, res: Response) => {
  const stats = await cacheService.getStats();
  return SuccessResponse(res, 200, {
    message: "Cache statistics",
    data: stats
  });
};
```

### Clear Cache (Admin Only)

```typescript
// Clear specific collection cache
await cacheService.invalidateCollection('projects');

// Clear all cache (use with extreme caution)
await cacheService.clearAll();
```

## Best Practices

1. **Use appropriate TTLs**: Short for frequently changing data, long for static data
2. **Namespace your keys**: Use prefixes like `user:`, `project:`, `post:`
3. **Handle cache misses gracefully**: Always have a fallback to fetch from database
4. **Invalidate on updates**: Clear cache when data changes
5. **Monitor cache hit rates**: Track effectiveness of caching strategy
6. **Don't cache sensitive data**: Avoid caching passwords, tokens, etc.
7. **Use batch operations**: When dealing with multiple items, use mset/mget
8. **Implement circuit breaker**: Fallback to database if Redis is down

## Error Handling

The cache service is designed to be non-blocking. If Redis is unavailable:
- Read operations return `null`
- Write operations return `false`
- The application continues to work without cache

This ensures your application remains functional even if Redis is temporarily unavailable.