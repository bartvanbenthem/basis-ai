.PHONY: test image push deploy undeploy uninstall url logs smoke run

# BASIS Lens: visual search on one GenAIStack (see README.md).
IMAGE ?= ghcr.io/bartvanbenthem/basis-lens
VERSION ?= v0.1.0
RUNTIME ?= docker
# The stack, its namespace, and the kubectl context of the location to deploy in
STACK ?= newtest
NAMESPACE ?= multi-region
CONTEXT ?= protected
# The app's own namespace in that location; created by deploy when missing.
# Several apps (or copies of this one) can use the stack, each from its own.
APP_NAMESPACE ?= lens
# Who may reach the app's LoadBalancer, comma-separated CIDRs; by default the
# clients of the stack's exposed gateway (control plane: the current context)
SOURCE_RANGES ?= $(shell kubectl -n $(NAMESPACE) get genaistack $(STACK) -o jsonpath='{.spec.gateway.expose.loadBalancerSourceRanges[*]}' | tr ' ' ',')

KUBECTL := kubectl --context $(CONTEXT) -n $(APP_NAMESPACE)
STACK_KUBECTL := kubectl --context $(CONTEXT) -n $(NAMESPACE)
# The stack's connection Secret, copied into the app's namespace: a Secret can
# only be mounted in its own namespace. The hash restarts the app when it changed.
CONNECTION = $(STACK_KUBECTL) get secret $(STACK)-connection -o go-template='---{{"\n"}}apiVersion: v1{{"\n"}}kind: Secret{{"\n"}}type: Opaque{{"\n"}}metadata: {name: $(STACK)-connection, namespace: $(APP_NAMESPACE), labels: {app.kubernetes.io/name: lens}}{{"\n"}}data:{{"\n"}}{{range $$k, $$v := .data}}  {{$$k}}: {{$$v}}{{"\n"}}{{end}}'
CONNECTION_HASH = $(shell $(STACK_KUBECTL) get secret $(STACK)-connection -o jsonpath='{.data}' 2>/dev/null | sha256sum | cut -c1-16)
MANIFEST = sed -e 's|__STACK__|$(STACK)|g' -e 's|__NAMESPACE__|$(NAMESPACE)|g' -e 's|__APP_NAMESPACE__|$(APP_NAMESPACE)|g' \
	-e 's|__IMAGE__|$(IMAGE):$(VERSION)|g' -e 's|__SOURCE_RANGES__|$(SOURCE_RANGES)|' -e 's|__CONNECTION_HASH__|$(CONNECTION_HASH)|' deploy/testapp.yaml

test:
	go vet ./...
	go test ./...

image:
	$(RUNTIME) build -t $(IMAGE):$(VERSION) .

push: image
	$(RUNTIME) push $(IMAGE):$(VERSION)

# Run it again after a switchover or a key rotation: it refreshes the copied Secret.
deploy:
	@test -n "$(SOURCE_RANGES)" || { echo "SOURCE_RANGES: the CIDRs that may reach the app, e.g. 203.0.113.7/32"; exit 1; }
	@kubectl --context $(CONTEXT) get namespace $(APP_NAMESPACE) >/dev/null 2>&1 || { \
	  kubectl --context $(CONTEXT) create namespace $(APP_NAMESPACE) && \
	  kubectl --context $(CONTEXT) label namespace $(APP_NAMESPACE) app.kubernetes.io/created-by=lens \
	    pod-security.kubernetes.io/enforce=restricted; }
	{ $(MANIFEST); $(CONNECTION); } | kubectl --context $(CONTEXT) apply -f -
	$(KUBECTL) rollout status deploy/lens --timeout=3m
	@$(MAKE) --no-print-directory url

# Removes the app from this location, and its namespace if deploy created it;
# the photo library stays in the database
undeploy:
	$(MANIFEST) | kubectl --context $(CONTEXT) delete --ignore-not-found -f -
	$(KUBECTL) delete secret --ignore-not-found $(STACK)-connection
	kubectl --context $(CONTEXT) delete namespace -l app.kubernetes.io/created-by=lens,kubernetes.io/metadata.name=$(APP_NAMESPACE)

# undeploy, and drops the library (schema lens) on the database's primary. Run
# it on the active site: the standby's replica follows (undeploy it there).
# Cached entries expire within CACHE_TTL.
uninstall: undeploy
	@printf "Drop schema lens (all photos) in $(STACK)'s database via $(CONTEXT)? [y/N] "; read ok; [ "$$ok" = y ]
	$(STACK_KUBECTL) exec $$($(STACK_KUBECTL) get pod -l cnpg.io/cluster=$(STACK)-db,cnpg.io/instanceRole=primary -o name) -c postgres -- \
	  psql -d app -v ON_ERROR_STOP=1 -c 'DROP SCHEMA IF EXISTS lens CASCADE'

# The app's address, once the LoadBalancer has one
url:
	@for i in $$(seq 60); do \
	  ip=$$($(KUBECTL) get svc lens -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}'); \
	  [ -n "$$ip" ] && { echo "BASIS Lens: http://$$ip (for $(SOURCE_RANGES))"; exit 0; }; sleep 5; done; \
	echo "no LoadBalancer address yet: $(KUBECTL) get svc lens"; exit 1

logs:
	$(KUBECTL) logs deploy/lens -f

# End-to-end check of the stack through the app (on the LoadBalancer by default)
BASE_URL ?= http://$(shell $(KUBECTL) get svc lens -o jsonpath='{.status.loadBalancer.ingress[0].ip}{.status.loadBalancer.ingress[0].hostname}')
smoke:
	./smoke.sh $(BASE_URL)

# On this machine, against the stack's external endpoints (see local-env.sh)
run:
	eval "$$(./local-env.sh $(STACK) $(NAMESPACE) $(CONTEXT))" && go run .
