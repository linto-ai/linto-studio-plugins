PACKAGE_DIRS := . Transcriber Session-API Scheduler Microsoft-Teams-Scheduler migration lib

# Load .env as override if it exists
ENV_FILE_ARGS = --env-file .envdefault.docker $(if $(wildcard .env),--env-file .env)

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

run-docker-dev-linto-studio:
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) up --build

stop-docker-dev-linto-studio:
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) stop

down-docker-dev-linto-studio:
	docker compose -f compose.yml -f compose.override.yml -f compose.linto-studio.yml $(ENV_FILE_ARGS) down

clean-node-modules:
	find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

clean-docker-node-modules:
	docker run --rm -v $(PWD):/app -w /app node:20 /bin/sh -c 'find . -name "node_modules" -type d -prune -exec rm -rf {} +'

.PHONY: run-docker-dev run-dev down-docker-dev run-docker-prod clean-node-modules clean-docker-node-modules
.PHONY: install-local $(PACKAGE_DIRS)
