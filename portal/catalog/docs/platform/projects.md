# Projects

A **Project** is a team's space on the platform: a namespace on the control plane (where its
PostgresClusters live) and in its locations, with its own Prometheus and Grafana.

```yaml
apiVersion: platform.cndev.nl/v1alpha1
kind: Project
metadata:
  name: team-payments        # also the namespace
spec:
  owner: team-payments       # Backstage group
  locations:
    protected: dc-a          # where its databases run
    recovery: dc-b           # optional: replica clusters
  access:
    - group: team-payments-devs
      role: edit             # admin, edit or view
```

## What a Project gets

| Where | What |
|---|---|
| Control plane | The namespace, RoleBindings per `access` entry, a Prometheus that receives the locations' metrics, a Grafana with the clusters' dashboards, and a backup bucket (COSI) with keys per location |
| Each location | The namespace, the same RoleBindings, an optional quota, and a Prometheus that scrapes the clusters, evaluates their alerts and sends its samples to the control plane |

## Rules

- The **sites can't move** once set: the databases and their replicas would be stranded. A recovery
  location can be added later. To leave a location, create a Project elsewhere and restore the
  databases there from their backups.
- **Deletion protection** (`deletionProtection: true`, the default) stops a Project from being
  deleted. Deleting it deletes its namespace and every cluster in it; the portal only deletes empty
  Projects.
- **Names** are DNS labels of up to 40 characters, without `--`, and not a system namespace.
- The **backup bucket** is kept when the Project is deleted, with its backups. Remove it in the object
  store once they're no longer needed.

The Project's page in the portal shows its clusters, sites, bucket (and whether each location
reaches it) and the backup folders you can restore from.
