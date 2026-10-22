.PHONY: test image push deploy undeploy url logs smoke run

# BASIS Lens: visual search on one GenAIStack (see README.md).
IMAGE ?= ghcr.io/bartvanbenthem/basis-lens
VERSION ?= v0.1.0
RUNTIME ?= docker
# The stack, its namespace, and the kubectl context of the location to deploy in
STACK ?= newtest
NAMESPACE ?= multi-region
CONTEXT ?= protected
# Who may reach the app's LoadBalancer, comma-separated CIDRs; by default the
# clients of the stack's exposed gateway (control plane: the current context)
SOURCE_RANGES ?= $(shell kubectl -n $(NAMESPACE) get genaistack $(STACK) -o jsonpath='{.spec.gateway.expose.loadBalancerSourceRanges[*]}' | tr ' ' ',')

KUBECTL := kubectl --context $(CONTEXT) -n $(NAMESPACE)
MANIFEST = sed -e 's|__STACK__|$(STACK)|g' -e 's|__IMAGE__|$(IMAGE):$(VERSION)|g' -e 's|__SOURCE_RANGES__|$(SOURCE_RANGES)|' deploy/testapp.yaml

test:
	go vet ./...
	go test ./...

image:
	$(RUNTIME) build -t $(IMAGE):$(VERSION) .

push: image
	$(RUNTIME) push $(IMAGE):$(VERSION)

deploy:
	@test -n "$(SOURCE_RANGES)" || { echo "SOURCE_RANGES: the CIDRs that may reach the app, e.g. 203.0.113.7/32"; exit 1; }
	$(MANIFEST) | $(KUBECTL) apply -f -
	$(KUBECTL) rollout status deploy/lens --timeout=3m
	@$(MAKE) --no-print-directory url

undeploy:
	$(MANIFEST) | $(KUBECTL) delete --ignore-not-found -f -

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
