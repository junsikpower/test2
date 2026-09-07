ifeq ($(OS),Windows_NT)
SHELL := C:/Program Files/Git/bin/bash.exe
.SHELLFLAGS := -c
endif

.PHONY: setup build lint test-dev test-review

setup:
	npm ci

build:
	node build.js

lint:
	@files=$$(find . -name node_modules -prune -o -name '*.js' -print); \
	for f in $$files; do echo "lint $$f"; node --check "$$f" || exit 1; done

test-dev:
	mkdir -p reports
	JEST_JUNIT_OUTPUT_NAME=dev.xml npx jest --config jest.config.js --ci tests/dev

test-review:
	mkdir -p reports
	JEST_JUNIT_OUTPUT_NAME=review.xml npx jest --config jest.config.js --ci tests/review
