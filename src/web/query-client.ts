import { notifyManager, QueryClient, QueryClientContext } from "@tanstack/react-query";
import { useContext } from "react";

// 使用微任务批量通知订阅者，确保单测假时钟（vi.useFakeTimers）与异步交互下状态及时同步。
notifyManager.setScheduler(queueMicrotask);

const DEFAULT_QUERY_STALE_TIME_MS = 30_000;
const DEFAULT_QUERY_GC_TIME_MS = 5 * 60_000;

function createHubQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: DEFAULT_QUERY_STALE_TIME_MS,
        gcTime: DEFAULT_QUERY_GC_TIME_MS,
        retry: false,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export const queryClient: QueryClient = createHubQueryClient();

/** 测试用例结束后清空全局查询缓存，防止跨用例状态污染。 */
export function resetQueryClient(): void {
  queryClient.clear();
}

/** 优先读取外层 QueryClientProvider，单测直接渲染子组件未包 Provider 时回退到共享 queryClient。 */
export function useHubQueryClient(): QueryClient {
  return useContext(QueryClientContext) ?? queryClient;
}
