PACKAGE_DIRS := . Transcriber Session-API Scheduler migration lib

# Load .env as override if it exists
ENV_FILE_ARGS = --env-file .envdefault.docker $(if $(wildcard .env),--env-file .env)

# Path to LinTO Studio repository (sibling directory by default)
LINTO_STUDIO_PATH ?= ../linto-studio
export LINTO_STUDIO_PATH

# Absolute path to emeeting root (for compose env_file resolution)
export EMEETING_ROOT := $(CURDIR)

install-local: $(PACKAGE_DIRS)

$(PACKAGE_DIRS):
	cd $@ && npm install

migrate:
	bash -c 'set -a; source .envdefault; if [ -f .env ]; then source .env; fi; set +a; cd migration && npm run migrate'

run-dev: migrate
	npm start

build-docker-dev:
	docker compose $(ENV_FILE_ARGS) build

run-docker-dev:
	docker compose $(ENV_FILE_ARGS) up

stop-docker-dev:
	docker compose $(ENV_FILE_ARGS) stop

down-docker-dev:
	docker compose $(ENV_FILE_ARGS) down

run-docker-prod:
	docker compose -f compose.yml -f compose.prod.yml up --build

check-linto-studio:
	@if [ ! -d "$(LINTO_STUDIO_PATH)" ]; then \
		echo "Error: LinTO Studio not found at $(LINTO_STUDIO_PATH)"; \
		echo "Clone it with: git clone https://github.com/linto-ai/linto-studio.git $(LINTO_STUDIO_PATH)"; \
		echo "Or set a custom path: make run-docker-dev-linto-studio LINTO_STUDIO_PATH=/path/to/linto-studio"; \
		exit 1; \
	fi

run-docker-dev-linto-studio: check-linto-studio
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) up --build

stop-docker-dev-linto-studio: check-linto-studio
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) stop

down-docker-dev-linto-studio: check-linto-studio
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) down

clean-node-modules:
	find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

clean-docker-node-modules:
	docker run --rm -v $(PWD):/app -w /app node:20 /bin/sh -c 'find . -name "node_modules" -type d -prune -exec rm -rf {} +'

# ---------------------------------------------------------------------------
# Integration tests (containerized harness in tests/integration/)
# ---------------------------------------------------------------------------
INTEGRATION_COMPOSE := tests/integration/docker-compose.test.yml
INTEGRATION_PROJECT := emeeting-integration-test

test-integration:
	bash tests/integration/run.sh

test-integration-up:
	docker compose -p $(INTEGRATION_PROJECT) -f $(INTEGRATION_COMPOSE) up -d --build

test-integration-down:
	docker compose -p $(INTEGRATION_PROJECT) -f $(INTEGRATION_COMPOSE) down -v --remove-orphans

test-integration-logs:
	docker compose -p $(INTEGRATION_PROJECT) -f $(INTEGRATION_COMPOSE) logs -f --tail=200

test-integration-smoke:
	bash tests/integration/scenarios/00-smoke.sh

# Standalone harness self-tests (no Docker, no stack required).
test-integration-harness:
	bash tests/integration/harness/test-cleanup-scoped.sh

# ---------------------------------------------------------------------------
# Unit tests (per Node service)
#
# Each service has its own Mocha suite. We invoke them sequentially so a
# failure in one is visible and not swallowed by later output. `npm test`
# requires node_modules; the `*-deps` prerequisite makes sure they exist.
# ---------------------------------------------------------------------------
UNIT_TEST_SERVICES := Transcriber Session-API Scheduler

test-unit-deps:
	@for svc in $(UNIT_TEST_SERVICES); do \
		if [ ! -d "$$svc/node_modules" ]; then \
			echo "==> installing deps for $$svc"; \
			(cd "$$svc" && npm install) || exit 1; \
		fi; \
	done

test-unit-transcriber: test-unit-deps
	cd Transcriber && npm test

test-unit-sessionapi: test-unit-deps
	cd Session-API && npm test

test-unit-scheduler: test-unit-deps
	cd Scheduler && npm test

test-unit: test-unit-transcriber test-unit-sessionapi test-unit-scheduler

# ---------------------------------------------------------------------------
# Full test suite — CI-style. Long but exhaustive.
#
# Order:
#   1. Harness self-tests (fast, no Docker).
#   2. Unit tests per service.
#   3. Containerized integration suite (every scenario in tests/integration/
#      scenarios/, including the multi-instance failover scenario which
#      brings up its own extra Transcriber container).
#
# Stops at the first failing step. Print a summary line at the very end so
# the result is unambiguous in CI logs.
# ---------------------------------------------------------------------------
test-all:
	@echo "==> [1/3] harness self-tests"
	$(MAKE) test-integration-harness
	@echo "==> [2/3] unit tests"
	$(MAKE) test-unit
	@echo "==> [3/3] integration scenarios"
	$(MAKE) test-integration
	@echo "==> ALL TESTS PASSED"

.PHONY: run-docker-dev run-dev down-docker-dev run-docker-prod clean-node-modules clean-docker-node-modules check-linto-studio
.PHONY: install-local $(PACKAGE_DIRS)
.PHONY: test-integration test-integration-up test-integration-down test-integration-logs test-integration-smoke test-integration-harness
.PHONY: test-unit-deps test-unit test-unit-transcriber test-unit-sessionapi test-unit-scheduler test-all
