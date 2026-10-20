# COSI en de Cloudian-driver

## Inleiding
COSI (Container Object Storage Interface) is de Kubernetes-standaard voor het provisionen van object storage (buckets). Kubernetes SIG Storage levert de generieke componenten (API, controller, sidecar); Cloudian levert de driver die de koppeling maakt met HyperStore.

De scheiding is vergelijkbaar met CSI: de API en de orkestratie zijn vendor-onafhankelijk, de driver implementeert de vendor-specifieke logica via een gRPC-interface. Driver en sidecar moeten dezelfde API-versie spreken.

## Componenten

| Onderdeel | Bron | Verantwoordelijkheid |
|---|---|---|
| CRD's (`BucketClass`, `BucketClaim`, `Bucket`, `BucketAccessClass`, `BucketAccess`) | kubernetes-sigs | API voor het aanvragen van buckets en toegang |
| Controller | kubernetes-sigs | Reconcileert `BucketClaim` naar `Bucket` |
| Sidecar | kubernetes-sigs | Draait naast de driver; vertaalt `Bucket`/`BucketAccess` naar gRPC-calls |
| Driver | Cloudian | Maakt buckets en credentials aan in HyperStore |

## Installatie
CRD's en controller (`cosi-system`) en de driver (`cloudian-cosi`) staan allemaal in `upstream/`, de scripts hebben geen netwerk nodig behalve het cluster:

```bash
./install.sh     # keys en endpoints uit env/00-env.sh; ook om ze te wijzigen
./uninstall.sh   # alleen de driver; buckets en keys blijven
```

- Draai één driver per cluster. Elke kopie neemt zijn leader-lease in zijn eigen namespace, dus twee kopieën granten elke `BucketAccess` dubbel. `install.sh` weigert als de driver al in een andere namespace draait.
- Verhuizen naar een andere namespace: `NAMESPACE=<oud> ./uninstall.sh`, daarna `NAMESPACE=<nieuw> ./install.sh`. Buckets, accesses en Secrets verwijzen alleen naar de drivernaam en blijven werken; tussendoor wordt niets gegrant of ingetrokken.
- `REMOVE_CRDS=true ./uninstall.sh` verwijdert ook CRD's en controller, maar pas als er geen `Bucket` meer is.

## Flow
1. Een gebruiker maakt een `BucketClaim` aan.
2. De controller maakt op basis daarvan een `Bucket`-object aan.
3. De sidecar detecteert het `Bucket`-object en roept de driver aan (`DriverCreateBucket`).
4. De Cloudian-driver maakt de bucket aan in HyperStore.
5. Bij een `BucketAccess` vraagt de sidecar credentials op bij de driver en schrijft deze naar een Kubernetes `Secret`.

## Upgrade-blokkade
Upstream is COSI gemigreerd van `v1alpha1` naar `v1alpha2`. Deze versies zijn niet compatibel: zowel de CRD's als de gRPC-interface tussen sidecar en driver zijn gewijzigd.

De huidige Cloudian-driver (`v0.1.0`) ondersteunt alleen `v1alpha1`. Een upgrade van de sigs-componenten zonder bijbehorende driver resulteert in een niet-functionerende installatie.

## Conclusie
- We blijven voorlopig op `v1alpha1`, in lijn met de huidige Cloudian-driver.
- Deze versie wordt upstream niet meer onderhouden, maar is functioneel stabiel.
- Een upgrade is pas mogelijk zodra Cloudian een driver voor `v1alpha2` uitbrengt. CRD's, controller, sidecar en driver worden dan gelijktijdig vervangen.
- Controleer dit bij elke nieuwe Cloudian-release: pull de nieuwe chart naar `upstream/charts/` (zie de header van `install.sh`).
