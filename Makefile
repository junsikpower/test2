ifeq ($(OS),Windows_NT)
SHELL := C:/Program Files/Git/bin/bash.exe
.SHELLFLAGS := -c
endif

.PHONY: setup build lint test-dev test-review

setup:
	npm ci

build:
	node scripts/build-check.js

lint:
	node scripts/lint.js

test-dev:
	mkdir -p reports
	JEST_JUNIT_OUTPUT_DIR=reports JEST_JUNIT_OUTPUT_NAME=dev.xml ./node_modules/.bin/jest tests/dev --ci

test-review:
	mkdir -p reports
	JEST_JUNIT_OUTPUT_DIR=reports JEST_JUNIT_OUTPUT_NAME=review.xml ./node_modules/.bin/jest tests/review --ci
