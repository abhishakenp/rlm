#!/bin/bash
cd /app
git apply /patches/test.patch || { echo "TEST PATCH APPLY FAILED"; exit 9; }
run() {
  ./test.sh --output_path "/tmp/$2.xml" "$1" > "/tmp/$2.log" 2>&1
  local rc=$?
  echo "$2: exit=$rc testcases=$(grep -o '<testcase' /tmp/$2.xml 2>/dev/null | wc -l) failures=$(grep -o '<failure' /tmp/$2.xml 2>/dev/null | wc -l)"
}
echo "### PHASE 1: test patch only"
run base base1
run new new1
echo "--- new1 tail:"; tail -3 /tmp/new1.log
echo "--- restored?"; ls db5024_test.go
echo "### PHASE 2: + solution"
git apply /patches/solution.patch || { echo "SOLUTION PATCH APPLY FAILED"; exit 9; }
run base base2
run new new2
