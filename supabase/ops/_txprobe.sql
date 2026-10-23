-- Is a multi-statement query string ONE transaction on this endpoint?
-- Probe: create a table, roll back, then check whether it survived.
BEGIN;
CREATE TABLE public._tx_probe_tmp(x integer);
ROLLBACK;
SELECT to_regclass('public._tx_probe_tmp') IS NOT NULL AS table_survived_rollback;
