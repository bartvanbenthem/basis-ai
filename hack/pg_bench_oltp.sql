-- pg_bench_oltp.sql
-- "Normal app" PostgreSQL benchmark via psql: a small webshop schema and a
-- mixed workload of short, indexed transactions (mostly reads, some writes),
-- each committed individually. Complements pg_bench_rawio.sql, which measures
-- bulk/maintenance throughput.
-- Run with:  psql -d yourdb -f pg_bench_oltp.sql
--
-- Everything lives in the scratch schema bench_oltp (dropped at the end),
-- so it's safe to run against any DB you have CREATE privileges on.
-- Requires PostgreSQL 11+ (COMMIT inside DO). Single session only; it shows
-- per-transaction latency, not concurrency behaviour.

\timing on
\set CUSTOMERS  50000
\set PRODUCTS   5000
\set ORDERS     200000
\set ITERATIONS 20000

-- Cleanup from any previous run
DROP SCHEMA IF EXISTS bench_oltp CASCADE;

\echo '--- Setup ---'
CREATE SCHEMA bench_oltp;
SET search_path = bench_oltp;

CREATE TABLE customers (
    id         bigserial PRIMARY KEY,
    email      text NOT NULL UNIQUE,
    name       text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_login timestamptz
);

CREATE TABLE products (
    id    serial PRIMARY KEY,
    sku   text NOT NULL UNIQUE,
    name  text NOT NULL,
    price numeric(10,2) NOT NULL,
    stock integer NOT NULL
);

CREATE TABLE orders (
    id          bigserial PRIMARY KEY,
    customer_id bigint NOT NULL REFERENCES customers (id),
    status      text NOT NULL DEFAULT 'new',
    created_at  timestamptz NOT NULL DEFAULT now(),
    total       numeric(12,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_orders_customer_created ON orders (customer_id, created_at DESC);

CREATE TABLE order_items (
    order_id   bigint  NOT NULL REFERENCES orders (id),
    product_id integer NOT NULL REFERENCES products (id),
    qty        integer NOT NULL,
    unit_price numeric(10,2) NOT NULL,
    PRIMARY KEY (order_id, product_id)
);
CREATE INDEX idx_order_items_product ON order_items (product_id);

\echo '--- Seed data (:CUSTOMERS customers, :PRODUCTS products, :ORDERS orders) ---'
INSERT INTO customers (email, name, created_at, last_login)
SELECT 'user' || g || '@example.com',
       'Customer ' || g,
       now() - random() * interval '3 years',
       now() - random() * interval '30 days'
FROM generate_series(1, :CUSTOMERS) AS g;

INSERT INTO products (sku, name, price, stock)
SELECT 'SKU-' || lpad(g::text, 6, '0'),
       'Product ' || g,
       round((1 + random() * 499)::numeric, 2),
       100000
FROM generate_series(1, :PRODUCTS) AS g;

INSERT INTO orders (customer_id, status, created_at)
SELECT 1 + floor(random() * :CUSTOMERS)::bigint,
       (ARRAY['new','paid','shipped','delivered'])[1 + floor(random() * 4)::int],
       now() - random() * interval '1 year'
FROM generate_series(1, :ORDERS);

-- 1-4 distinct products per order
INSERT INTO order_items (order_id, product_id, qty, unit_price)
SELECT o.id, p.id, 1 + floor(random() * 3)::int, p.price
FROM orders o
CROSS JOIN LATERAL (
    SELECT DISTINCT 1 + floor(random() * :PRODUCTS)::int AS pid
    FROM generate_series(1, 1 + (o.id % 4)::int)
) pick
JOIN products p ON p.id = pick.pid;

UPDATE orders o SET total = s.total
FROM (SELECT order_id, sum(qty * unit_price) AS total
      FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

VACUUM ANALYZE;

\echo '--- Data size ---'
SELECT pg_size_pretty(sum(pg_total_relation_size(c.oid))) AS bench_oltp_size
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'bench_oltp' AND c.relkind = 'r';

\echo '--- Mixed OLTP workload (:ITERATIONS transactions, one COMMIT each) ---'
-- psql variables aren't expanded inside $$ ... $$, so pass them as settings.
SET bench.iterations = :'ITERATIONS';
SET bench.customers  = :'CUSTOMERS';
SET bench.products   = :'PRODUCTS';

DO $$
DECLARE
    n_iter  int := current_setting('bench.iterations')::int;
    n_cust  int := current_setting('bench.customers')::int;
    n_prod  int := current_setting('bench.products')::int;
    max_ord bigint;
    names   text[]   := ARRAY['customer lookup (email)',
                              'order history (join, top 10)',
                              'product page (sku + sales count)',
                              'place order (insert + stock update)',
                              'update order status',
                              'customer login (update)'];
    cnt     int[]    := ARRAY[0,0,0,0,0,0];
    dur     float8[] := ARRAY[0,0,0,0,0,0];
    t_start timestamptz := clock_timestamp();
    t0      timestamptz;
    total_s float8;
    r       float8;
    op      int;
    c_id    bigint;
    p_id    int;
    o_id    bigint;
    rec     record;
BEGIN
    SELECT max(id) INTO max_ord FROM orders;

    FOR i IN 1..n_iter LOOP
        r    := random();
        c_id := 1 + floor(random() * n_cust)::bigint;
        p_id := 1 + floor(random() * n_prod)::int;
        t0   := clock_timestamp();

        -- Mix: ~80% reads, ~20% writes
        IF r < 0.30 THEN
            op := 1;
            SELECT * INTO rec FROM customers
            WHERE email = 'user' || c_id || '@example.com';

        ELSIF r < 0.55 THEN
            op := 2;
            PERFORM o.id, o.created_at, o.status, o.total, count(*)
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            WHERE o.customer_id = c_id
            GROUP BY o.id
            ORDER BY o.created_at DESC
            LIMIT 10;

        ELSIF r < 0.80 THEN
            op := 3;
            SELECT * INTO rec FROM products
            WHERE sku = 'SKU-' || lpad(p_id::text, 6, '0');
            PERFORM count(*) FROM order_items WHERE product_id = p_id;

        ELSIF r < 0.90 THEN
            op := 4;
            INSERT INTO orders (customer_id) VALUES (c_id) RETURNING id INTO o_id;

            INSERT INTO order_items (order_id, product_id, qty, unit_price)
            SELECT o_id, p.id, 1 + floor(random() * 3)::int, p.price
            FROM (SELECT DISTINCT 1 + floor(random() * n_prod)::int AS pid
                  FROM generate_series(1, 1 + floor(random() * 4)::int)) pick
            JOIN products p ON p.id = pick.pid;

            UPDATE products p SET stock = p.stock - oi.qty
            FROM order_items oi
            WHERE oi.order_id = o_id AND p.id = oi.product_id;

            UPDATE orders SET total = (SELECT sum(qty * unit_price)
                                       FROM order_items WHERE order_id = o_id)
            WHERE id = o_id;

        ELSIF r < 0.97 THEN
            op := 5;
            -- pick the id up front: random() in WHERE is volatile and forces a seq scan
            o_id := 1 + floor(random() * max_ord)::bigint;
            UPDATE orders
            SET status = (ARRAY['paid','shipped','delivered'])[1 + floor(random() * 3)::int]
            WHERE id = o_id;

        ELSE
            op := 6;
            UPDATE customers SET last_login = now() WHERE id = c_id;
        END IF;

        COMMIT;  -- counted in the latency: that's where the WAL flush happens

        cnt[op] := cnt[op] + 1;
        dur[op] := dur[op] + extract(epoch FROM clock_timestamp() - t0) * 1000;
    END LOOP;

    total_s := extract(epoch FROM clock_timestamp() - t_start);

    RAISE NOTICE '%', rpad('operation', 38) || lpad('count', 8) || lpad('avg ms', 10);
    FOR k IN 1..array_length(names, 1) LOOP
        RAISE NOTICE '%', rpad(names[k], 38)
                       || lpad(cnt[k]::text, 8)
                       || lpad(CASE WHEN cnt[k] > 0
                                    THEN to_char(dur[k] / cnt[k], 'FM990.000')
                                    ELSE '-' END, 10);
    END LOOP;
    RAISE NOTICE 'total: % transactions in % s  =>  % TPS',
        n_iter, round(total_s::numeric, 2), round((n_iter / total_s)::numeric, 1);
END $$;

\echo '--- Cleanup ---'
RESET search_path;
DROP SCHEMA bench_oltp CASCADE;

\timing off
\echo '--- Done ---'
