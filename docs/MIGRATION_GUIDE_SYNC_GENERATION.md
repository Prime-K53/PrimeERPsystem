# Sync Generation Fix Migration Guide

## Overview
This document describes the fixes applied to address the three warning classes in the Prime ERP system.

## Changes Made

### 1. Sync Generation Assignment (durableSyncQueue.ts)
- Ensured every new operation gets the current sync generation at enqueue time
- Added explicit handling for missing generation scenarios
- Preserved legacy operation quarantine path

### 2. Settings Classification (usePagination.ts)
- Classified prime:pagination:default as local-only UI state
- Removed cloud sync for pagination preference
- Now uses localStorage only, not dbService.saveSetting

### 3. Lifecycle Management (syncService.ts)
- startPeriodicSync is now properly idempotent
- Multiple calls don't create duplicate timers
- Lifecycle ownership is clear

### 4. Chart Container Sizing
- Added minimum heights to chart containers
- Ensured parent containers have measurable dimensions
- Prevents Recharts width/height warnings

## Testing
- Unit tests added for sync generation behavior
- Tests cover legacy operation quarantine
- Tests verify company reset safety is preserved

## Rollout
No database migration required. Changes are frontend-only code updates.
restart the dev server to pick up changes.
