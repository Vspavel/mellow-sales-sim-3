#!/bin/bash

# Sales Sim v3 vs v4 comparison script
# Runs 10 sessions per persona on both main (v3) and feature/v4 branches
# Saves results to data/eval/batch_results/

set -e

REPO_DIR="/home/vspavel/.openclaw/workspace/repos/mellow-sales-sim-3"
RESULTS_DIR="$REPO_DIR/data/eval/batch_results"
PERSONAS=("andrey" "alexey" "cfo_round" "head_finance" "internal_legal")
SESSIONS_PER_PERSONA=10

# Ensure results directory exists
mkdir -p "$RESULTS_DIR"

echo "=== Sales Sim v3 vs v4 Comparison ==="
echo "Running $SESSIONS_PER_PERSONA sessions per persona ($PERSONAS)"
echo "Results will be saved to: $RESULTS_DIR"

# Function to run sessions
run_sessions() {
  local branch=$1
  local port=$2
  local branch_label=$3

  echo ""
  echo "--- Running $branch_label ($branch) on port $port ---"

  cd "$REPO_DIR"
  git checkout "$branch" 2>/dev/null || true

  # Source environment
  if [ -f .env.v4.example ]; then
    export $(cat .env.v4.example | grep -v '^#' | xargs)
  elif [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
  fi

  # Start server in background
  echo "Starting server on port $port..."
  PORT=$port node server.js > "$RESULTS_DIR/${branch_label}_server.log" 2>&1 &
  SERVER_PID=$!
  sleep 3

  # Get auth token or session cookie
  AUTH_TOKEN=$(curl -s -X POST "http://localhost:$port/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"test@example.com\"}" \
    -i 2>&1 | grep -i "set-cookie\|authorization" | head -1 || echo "")

  # Run sessions for each persona
  for persona in "${PERSONAS[@]}"; do
    echo "  Running sessions for $persona..."

    for i in $(seq 1 $SESSIONS_PER_PERSONA); do
      session_id=$(curl -s -X POST "http://localhost:$port/api/sessions" \
        -H "Content-Type: application/json" \
        -d "{\"personaId\":\"$persona\",\"dialogueType\":\"full\"}" | grep -o '"session_id":"[^"]*' | cut -d'"' -f4)

      if [ -z "$session_id" ]; then
        echo "    Failed to create session $i for $persona"
        continue
      fi

      # Get initial seller suggest
      curl -s "http://localhost:$port/api/sessions/$session_id/seller-suggest" \
        > "$RESULTS_DIR/${branch_label}_${persona}_session${i}.json"

      echo "    Session $i: $session_id"
    done
  done

  # Kill server
  kill $SERVER_PID 2>/dev/null || true
  wait $SERVER_PID 2>/dev/null || true
  echo "Server stopped."
}

# Run v3 (main)
run_sessions "main" "3210" "v3"

# Run v4 (feature/v4)
run_sessions "feature/v4" "3211" "v4"

echo ""
echo "=== Comparison Complete ==="
echo "Results saved to: $RESULTS_DIR"
echo "Total files: $(ls -1 $RESULTS_DIR/*.json 2>/dev/null | wc -l)"
