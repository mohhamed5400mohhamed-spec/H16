import type { ChatShortcut } from './chatShortcuts';
import type { EmblemsConfig } from './emblemsSystem';
import type { RoleDefinition, StoryItem, WallPost } from '../types/chat';

const DELTA_CACHE_STORAGE_KEY = 'chathassan_delta_cache_v1';

export interface ClientConfigVersions {
  emblems?: string;
  shortcuts?: string;
  roles?: string;
  appearance?: string;
  wall?: string;
  stories?: string;
}

export interface ClientCachedAppearance {
  theme?: string;
  fontFamily?: string;
  fontWeight?: 'thin' | 'normal' | 'default' | 'bold' | 'black';
  wallpaper?: string;
  bubbleStyle?: string;
  bannerUrl?: string;
  logoUrl?: string;
  customThemes?: any[];
}

export interface ClientDeltaCacheState {
  versions: ClientConfigVersions;
  data: {
    emblemsConfig?: EmblemsConfig;
    shortcuts?: ChatShortcut[];
    rolesConfig?: RoleDefinition[];
    rolePermissions?: Record<string, any>;
    globalAppearance?: ClientCachedAppearance;
    generalWelcome?: { enabled: boolean; message: string; title: string };
    likesSettings?: any;
    wallPosts?: WallPost[];
    stories?: StoryItem[];
  };
  updatedAt: number;
}

let inMemoryDeltaCache: ClientDeltaCacheState | null = null;

function sanitizeWallPostsForCache(posts: WallPost[], limit = 50): WallPost[] {
  return posts.slice(0, limit).map((post) => {
    // Avoid storing huge inline data: URLs inside localStorage to protect storage quota
    const safeMediaUrl =
      post.mediaUrl && post.mediaUrl.startsWith('data:') && post.mediaUrl.length > 32768
        ? undefined
        : post.mediaUrl;
    return {
      ...post,
      mediaUrl: safeMediaUrl
    };
  });
}

export function readDeltaCache(): ClientDeltaCacheState {
  if (inMemoryDeltaCache) return inMemoryDeltaCache;
  const empty: ClientDeltaCacheState = { versions: {}, data: {}, updatedAt: 0 };
  if (typeof window === 'undefined') return empty;
  try {
    const raw = localStorage.getItem(DELTA_CACHE_STORAGE_KEY);
    if (!raw) {
      inMemoryDeltaCache = empty;
      return empty;
    }
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      inMemoryDeltaCache = {
        versions: parsed.versions && typeof parsed.versions === 'object' ? parsed.versions : {},
        data: parsed.data && typeof parsed.data === 'object' ? parsed.data : {},
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
      };
      return inMemoryDeltaCache;
    }
  } catch {}
  inMemoryDeltaCache = empty;
  return empty;
}

export function getCachedVersions(): ClientConfigVersions {
  return { ...readDeltaCache().versions };
}

export function saveDeltaCachePatch(patch: {
  versions?: Partial<ClientConfigVersions>;
  data?: Partial<ClientDeltaCacheState['data']>;
}): ClientDeltaCacheState {
  const current = readDeltaCache();
  const nextData: ClientDeltaCacheState['data'] = {
    ...current.data,
    ...(patch.data || {})
  };
  if (patch.data?.wallPosts) {
    nextData.wallPosts = sanitizeWallPostsForCache(patch.data.wallPosts, 50);
  }
  const next: ClientDeltaCacheState = {
    versions: {
      ...current.versions,
      ...(patch.versions || {})
    },
    data: nextData,
    updatedAt: Date.now()
  };
  inMemoryDeltaCache = next;

  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem(DELTA_CACHE_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // QuotaExceededError fallback: shrink cached wallPosts & stories and retry
      try {
        const trimmed: ClientDeltaCacheState = {
          ...next,
          data: {
            ...next.data,
            wallPosts: next.data.wallPosts ? sanitizeWallPostsForCache(next.data.wallPosts, 15) : undefined,
            stories: next.data.stories ? next.data.stories.slice(0, 10) : undefined
          }
        };
        inMemoryDeltaCache = trimmed;
        localStorage.setItem(DELTA_CACHE_STORAGE_KEY, JSON.stringify(trimmed));
      } catch {}
    }
  }
  return next;
}
