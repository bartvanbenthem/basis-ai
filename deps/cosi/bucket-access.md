# Toegang tot buckets en configuratie-opties

Dit document beschrijft hoe een applicatie toegang krijgt tot een COSI bucket en welke configuratie opties er zijn. Wat over het gedrag van de Cloudian driver staat, is afgeleid uit het gedrag op het cluster en de Project-composition ([composition.yaml](../../api/apis/project/composition.yaml)).

## Hoe toegang werkt

Er zijn twee lagen: de bucket zelf (`BucketClass` + `BucketClaim`) en de toegang tot die bucket (`BucketAccessClass` + `BucketAccess`).

```
BucketAccessClass (cluster-breed)       BucketClaim (namespace)
  driverName, authenticationType              │
            │                                 │
            └──────────► BucketAccess ◄───────┘
                         (namespace, zelfde als claim)
                              │
                     sidecar → DriverGrantBucketAccess → Cloudian
                              │
                              ▼
                  Secret <credentialsSecretName>
                    key: BucketInfo  (één JSON-blob)
```

1. Er wordt een `BucketAccess` aangemaakt (de Project-composition maakt er één per locatie). Die verwijst naar een `BucketClaim` en een `BucketAccessClass`, en geeft de naam op van het Secret dat moet worden aangemaakt.
2. De sidecar ziet het object en roept `DriverGrantBucketAccess` aan op de Cloudian-driver.
3. De driver maakt in HyperStore een identiteit aan met rechten op alleen die ene bucket, en een access key/secret key voor die identiteit.
4. De sidecar schrijft het resultaat naar het Secret. Daarna staat `status.accessGranted: true` op de `BucketAccess`.
5. Bij het verwijderen van de `BucketAccess` wordt `DriverRevokeBucketAccess` aangeroepen en worden de credentials ingetrokken.

### Inhoud van het Secret

Het Secret heeft geen losse keys zoals `AWS_ACCESS_KEY_ID`, maar één key `BucketInfo` met JSON erin (de Project-composition zet het om naar Secret `backup-s3-<locatie>`):

```json
{ "spec": {
    "bucketName": "project-<naam>-backups<uid>",
    "secretS3": { "endpoint": "...", "region": "...",
                  "accessKeyID": "...", "accessSecretKey": "..." } } }
```

Een applicatie kan dus niet simpelweg `envFrom: secretRef` gebruiken. Mogelijkheden:

- Het Secret als volume mounten en `BucketInfo` in de app parsen. Veel COSI-aware libraries doen dit al.
- Een init-container het JSON laten omzetten naar env-vars of een AWS-configbestand.
- Een operator of script de losse velden in een eigen Secret laten zetten.

### Aandachtspunten

- **De bucketnaam is niet zelf te kiezen.** De COSI-controller maakt hem aan als `<BucketClassName><claim-UID>`. De app moet de naam uit `BucketInfo` lezen.
- **Namespace-grens.** `BucketAccess`, `BucketClaim`, `ServiceAccount` en het Secret moeten in dezelfde namespace staan. Toegang vanuit een andere namespace kan in v1alpha1 niet.
- **Meerdere `BucketAccess`-objecten per claim kan wel.** Elk krijgt een eigen set credentials, bijvoorbeeld één per app. Dan is toegang ook per app in te trekken.
- **De `serviceAccountName` doet in deze setup waarschijnlijk niets.** In de COSI-spec is `IAM` bedoeld voor workload identity: de pod gebruikt zijn ServiceAccount-token en er komen geen keys in het Secret. De Cloudian-driver geeft in IAM-modus toch statische keys terug, en de Project-composition gebruikt die. Het ServiceAccount dat de composition aanmaakt speelt bij het inloggen dus waarschijnlijk geen rol. *(Aanname, niet geverifieerd tegen de driverbroncode.)*
- **Onderscheid tussen read-only en read-write** zit niet in de v1alpha1-spec. Onbekend is of de Cloudian-driver daarvoor `parameters` op de `BucketAccessClass` ondersteunt.

## Configuratie-opties

### 1. Authenticatie: `authenticationType` (op de `BucketAccessClass`)

| | `IAM` (standaard, aanbevolen) | `KEY` |
|---|---|---|
| Hoe | De driver maakt met de eigen S3/IAM-credentials een IAM-user aan met een policy die alleen die bucket toelaat, plus access keys | De driver maakt via de HyperStore Admin API een HyperStore-user aan in een group |
| Driver heeft nodig | `s3.iamEndpoint`, `s3.accessKey`/`secretAccessKey` | Ook het `admin`-blok: `endpoint`, `username`, `password`, `group` |
| Waar de buckets komen | In het account van de driver-credentials | In de opgegeven group |

**Let op:** [install.sh](install.sh) zet `IAM` op de `BucketAccessClass` en vult het `admin`-blok niet in. Voor KEY-mode moeten beide in `install.sh` worden aangepast, anders heeft de driver geen admin-credentials en faalt de grant.

### 2. Driver (Helm-values, [install.sh](install.sh))

| Optie | Doel |
|---|---|
| `s3.s3Endpoint` / `s3.iamEndpoint` / `s3.region` | HyperStore-endpoints. Die komen in het `BucketInfo`-Secret terecht, dus apps moeten ze kunnen bereiken |
| `s3.accessKey` / `secretAccessKey` | De identiteit waarmee de driver buckets en users aanmaakt. Dit is het krachtigste credential in de hele keten |
| `existingCredentialsSecret` | Verwijst naar een bestaand Secret in plaats van de keys via Helm-values mee te geven. Beter voor productie, want dan staan de keys niet in de Helm-release |
| `existingS3CertificateSecret` | Een eigen CA mounten voor de driver, voor endpoints met een private CA |
| `disableTLSCertificateCheck` | Alleen voor self-signed. De huidige HyperStore-endpoints valideren tegen de system store |
| `admin.*` | Alleen voor KEY-mode, zie hierboven |

### 3. Buckets (`BucketClass`, één per Project)

- **`deletionPolicy`**: `Delete` verwijdert de S3-bucket als de claim wordt verwijderd. `Retain` laat de bucket en de data staan; de Project-composition gebruikt `Retain`.
- **`parameters`**: een vrije map die naar de driver gaat. Welke keys Cloudian ondersteunt, is niet gedocumenteerd in deze repo.

### 4. Variabelen van `install.sh` / `uninstall.sh`

| Variabele | Standaard | Opmerking |
|---|---|---|
| `COSI_ACCESS_KEY` / `COSI_SECRET_ACCESS_KEY` | verplicht | Zie §2 (`s3.accessKey` / `secretAccessKey`) |
| `NAMESPACE` | `cloudian-cosi` | Waar de driver draait |
| `COSI_S3_ENDPOINT` | verplicht | HyperStore S3-endpoint, bv. `https://s3.example.com` |
| `COSI_IAM_ENDPOINT` | verplicht | HyperStore IAM-endpoint, bv. `https://s3.example.com:16443` |
| `COSI_REGION` | `us-east-01` | |
| `REMOVE_CRDS` | `false` | Alleen `uninstall.sh`; weigert zolang er nog `Bucket`s zijn |
