import { useState, useMemo, useCallback, useEffect } from 'react';
import { dbService } from '../services/db';

const GLOBAL_STORAGE_KEY = 'prime:pagination:default';

function getGlobalItemsPerPage(fallback: number): number {
  try {
    const stored = localStorage.getItem(GLOBAL_STORAGE_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
  } catch { }
  return fallback;
}

export function usePagination<T>(data: T[], initialItemsPerPage: number = 25) {
  const safeData = Array.isArray(data) ? data : [];
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(() => getGlobalItemsPerPage(initialItemsPerPage));

  const maxPage = Math.ceil(safeData.length / itemsPerPage) || 1;

  useMemo(() => {
    if (currentPage > maxPage && maxPage > 0) {
      setCurrentPage(1);
    }
  }, [safeData.length, maxPage, currentPage]);

  const currentItems = useMemo(() => {
    const begin = (currentPage - 1) * itemsPerPage;
    const end = begin + itemsPerPage;
    return safeData.slice(begin, end);
  }, [safeData, currentPage, itemsPerPage]);

  const next = useCallback(() => {
    setCurrentPage((current) => Math.min(current + 1, maxPage));
  }, [maxPage]);

  const prev = useCallback(() => {
    setCurrentPage((current) => Math.max(current - 1, 1));
  }, []);

  const first = useCallback(() => {
    setCurrentPage(1);
  }, []);

  const last = useCallback(() => {
    setCurrentPage(maxPage);
  }, [maxPage]);

  const jump = useCallback((page: number) => {
    const pageNumber = Math.max(1, page);
    setCurrentPage(Math.min(pageNumber, maxPage));
  }, [maxPage]);

  const changeItemsPerPage = useCallback((count: number) => {
    setItemsPerPage(count);
    setCurrentPage(1);
  }, []);

  // Persist pagination preference locally. This is local UI state (page size
  // choice), not a sync'd business setting, so it must NOT enter the cloud sync
  // queue and must not be sent to the settings table.
  useEffect(() => {
    try { localStorage.setItem(GLOBAL_STORAGE_KEY, String(itemsPerPage)); } catch { /* quota */ }
  }, [itemsPerPage]);

  useEffect(() => {
    let cancelled = false;
    try {
      const cloud = localStorage.getItem(GLOBAL_STORAGE_KEY);
      if (!cancelled && cloud) {
        const parsed = parseInt(cloud, 10);
        if (!Number.isNaN(parsed) && parsed > 0 && parsed !== itemsPerPage) {
          setItemsPerPage(parsed);
        }
      }
    } catch { /* ignore */ }
    return () => { cancelled = true; };
  }, []);

  return { 
    next, 
    prev, 
    first,
    last,
    jump, 
    currentItems, 
    currentPage, 
    maxPage, 
    totalItems: safeData.length,
    itemsPerPage,
    setItemsPerPage: changeItemsPerPage
  };
}
