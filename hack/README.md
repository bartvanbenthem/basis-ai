# hack

Developer and operator scripts; none of them is part of an install.

| File | What |
|---|---|
| [`e2e-kind.sh`](e2e-kind.sh) | End-to-end test: a control plane and one location on kind (see [Test](../README.md#test)) |
| [`e2e-locations.sh`](e2e-locations.sh) | End-to-end test: a control plane, a protected and a recovery location, geo replication, restore and switchover |
| [`lib/function-basis.sh`](lib/function-basis.sh) | Sourced by the e2e scripts: installs function-basis built from this checkout |
| [`health_check.sh`](health_check.sh) | Health check of a geo-replicated cluster in both locations; reads the cluster, namespace and locations from `.env` in the repository root |
| [`useful-commands.md`](useful-commands.md) | `kubectl` and `cnpg` commands for one location and CNPG cluster: topology, geo replication, backups |
| [`pg_bench_rawio.sql`](pg_bench_rawio.sql) | psql benchmark of bulk and maintenance throughput (a scratch table) |
| [`pg_bench_oltp.sql`](pg_bench_oltp.sql) | psql benchmark of a mixed OLTP workload (a scratch schema) |
