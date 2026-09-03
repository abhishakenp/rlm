#!/usr/bin/env bash
# Compact iris output wrapper
iris "$@" | jq -c '.' 2>/dev/null || iris "$@"
