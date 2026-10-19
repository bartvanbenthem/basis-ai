# Getting started

## 1. A Project

Every cluster lives in a **Project**: your team's namespace, with its locations, access, and its own
Prometheus and Grafana. If your team has none yet, ask the platform team, or create one under
**Projects → New project** if you're allowed to.

## 2. A cluster

### In the portal

1. Open **New cluster** in the navigation, or **New RAG cluster** for embeddings and AI search.
2. Pick your **Project**, a **name** and a **size**. The form suggests volumes for the size.
3. Turn on what you need: backups (to the Project's bucket by default), connection pooling, geo
   replication, extensions.
4. **Validate** checks the manifest against the API without creating anything; **Create cluster**
   creates it.

The right-hand panel always shows the manifest the form produces. You can copy it into Git.

### With kubectl

```yaml
apiVersion: cnpg.cndev.nl/v1alpha1
kind: PostgresCluster
metadata:
  name: orders-db
  namespace: team-payments     # your Project
spec:
  size: s                      # 1 vCPU, 4Gi memory per instance
  storage:
    size: 20Gi
  backup:
    enabled: true              # to the Project's backup bucket
```

```sh
kubectl apply -f orders-db.yaml
kubectl get postgrescluster -n team-payments orders-db -w
```

The cluster is ready when `READY` is `True`. `kubectl describe` shows `status.message` while it
starts.

## 3. Connect

The cluster runs in your Project's protected location. Inside that cluster, applications use the
services and the `<name>-app` Secret:

| What | Where |
|---|---|
| Read-write (primary) | `<name>-rw.<namespace>.svc:5432` |
| Read-only (standbys) | `<name>-ro.<namespace>.svc:5432` |
| Through PgBouncer (with pooling) | `<name>-pooler-rw.<namespace>.svc:5432` |
| Credentials | Secret `<name>-app`: `username`, `password`, `dbname`, `uri`, `jdbc-uri` |

From other clusters, use the LoadBalancer Service `<name>-external` (`spec.expose`, on by default),
and restrict it to your applications' egress IPs with `expose.loadBalancerSourceRanges`:

```sh
LB_IP=$(kubectl -n team-payments get svc orders-db-external -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
PGPASS=$(kubectl -n team-payments get secret orders-db-app -o jsonpath='{.data.password}' | base64 -d)
psql "postgresql://app:${PGPASS}@${LB_IP}:5432/app?sslmode=require"
```

The `uri` in the Secret points at the in-cluster host, so don't use it from outside.

## 4. Watch it

The cluster page in the portal shows its health, instances, connection details and events, with tabs
for **Monitoring** (the Grafana dashboard), **Logs**, **Backups** and **Disaster recovery**. Alerts
go to your Project's Prometheus.
