-- pg_bench_rawio.sql
-- Quick-and-dirty PostgreSQL benchmark via psql.
-- Run with:  psql -d yourdb -f pg_bench_rawio.sql
--
-- Uses a scratch table (dropped at the end) so it's safe to run
-- against any DB you have CREATE privileges on.

\timing on
\set ROWS 1000000

-- Cleanup from any previous run
DROP TABLE IF EXISTS bench_test;

\echo '--- Setup ---'
CREATE TABLE bench_test (
    id bigserial PRIMARY KEY,
    val integer,
    payload text
);

\echo '--- INSERT benchmark (:ROWS rows, set-based) ---'
INSERT INTO bench_test (val, payload)
SELECT
    (random() * 1000000)::int,
    md5(g::text)
FROM generate_series(1, :ROWS) AS g;

\echo '--- Table size ---'
SELECT pg_size_pretty(pg_total_relation_size('bench_test'));

\echo '--- Sequential scan / aggregate benchmark ---'
SELECT count(*), avg(val) FROM bench_test;

\echo '--- Index creation benchmark ---'
CREATE INDEX idx_bench_val ON bench_test (val);

\echo '--- Index scan benchmark (point lookups x 1000) ---'
DO $$
DECLARE
    i int;
    r bench_test%ROWTYPE;
BEGIN
    FOR i IN 1..1000 LOOP
        SELECT * INTO r FROM bench_test WHERE val = (random() * 1000000)::int LIMIT 1;
    END LOOP;
END $$;

\echo '--- UPDATE benchmark (10% of rows) ---'
UPDATE bench_test SET payload = md5(random()::text)
WHERE id % 10 = 0;

\echo '--- DELETE benchmark (10% of rows) ---'
DELETE FROM bench_test WHERE id % 10 = 0;

\echo '--- VACUUM ANALYZE benchmark ---'
VACUUM ANALYZE bench_test;

\echo '--- Cleanup ---'
DROP TABLE bench_test;

\timing off
\echo '--- Done ---'
