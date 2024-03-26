PACKAGE_DIRS := . front-end Transcriber Session-API Scheduler Delivery migration lib

install-local: $(PACKAGE_DIRS)

$(PACKAGE_DIRS):
	cd $@ && npm install

migrate:
	bash -c 'set -a; source .envdefault; if [ -f .env ]; then source .env; fi; set +a; cd migration && npm run migrate'

run-dev: migrate
	npm start

run-docker-dev:
	docker compose up --build

down-docker-dev:
	docker compose down

run-docker-prod:
	docker compose -f compose.yml -f compose.prod.yml up --build

clean-node-modules:
	find . -name 'node_modules' -type d -prune -exec rm -rf '{}' +

clean-docker-node-modules:
	docker run --rm -v $(PWD):/app -w /app node:20 /bin/sh -c 'find . -name "node_modules" -type d -prune -exec rm -rf {} +'

.PHONY: run-docker-dev run-dev down-docker-dev run-docker-prod clean-node-modules clean-docker-node-modules
.PHONY: install-local $(PACKAGE_DIRS)
