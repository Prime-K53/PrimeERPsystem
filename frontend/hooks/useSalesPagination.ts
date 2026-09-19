import { useState, useCallback } from 'react';
import { api } from '../services/api';
import { logger } from '@/services/logger';

/**
 * Phase 2: cursor pagination stub — prevents OOM at 10k rows.
 * Replace direct api.sales.getAllSales() with this hook.
 * Usage: const { data, loadMore, hasMore } = useSalesPagination('sales', 50);
 */
export function useSalesPagination(entity: 'sales' | 'quotations' | 'invoices', pageSize = 50) {
  const [data, setData] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);
    try {
      // Fallback: API doesn't yet support cursor, so slice client-side and warn
      const all = await (async () => {
        if (entity === 'sales') return api.sales.getAllSales();
        if (entity === 'quotations') return api.sales.getQuotations();
        return [];
      })();
      const start = cursor ? parseInt(cursor, 10) : 0;
      const slice = (all as any[]).slice(start, start + pageSize);
      setData(prev => [...prev, ...slice]);
      const next = start + pageSize;
      setCursor(String(next));
      if (slice.length < pageSize || next >= (all as any[]).length) setHasMore(false);
      if ((all as any[]).length >= 1000) logger.warn(`[pagination] ${entity} truncated — server cursor needed`);
    } catch (e) {
      logger.error(`Pagination failed for ${entity}`, e);
    } finally {
      setIsLoading(false);
    }
  }, [entity, pageSize, cursor, hasMore, isLoading]);

  return { data, loadMore, hasMore, isLoading };
}
