#!/bin/bash
# Local emulation of the platform prechecks.
P=test.patch; D=Dockerfile; ok=0; bad=0
chk(){ if [ "$1" = "0" ]; then echo "PASS  $2"; ok=$((ok+1)); else echo "FAIL  $2 -- $3"; bad=$((bad+1)); fi; }

cd fresh2 && git checkout -q . && git clean -qfd && git apply --check ../$P 2>/tmp/e; chk $? "valid_git_diff" "$(cat /tmp/e)"; cd ..

grep -q "^+++ b/test.sh" $P; chk $? "test_runner_present" "no test.sh in patch"
grep -q "new file mode 100755" $P; chk $? "executable_permissions" "test.sh not 755"
grep -qE '^\+.*\bbase\b.*\)' $P && grep -qE '^\+.*\bnew\b.*\)' $P; chk $? "base_new_mode_support" "missing base/new modes"
grep -q '^\+.*--output_path' $P; chk $? "output_path_flag" "no --output_path parsing"
grep -q '^\+.*junit' $P; chk $? "junit_xml_output" "no junit writer"

# no implementation code in the test patch (only test.sh + *_test.go files)
files=$(grep '^+++ b/' $P | sed 's|^+++ b/||')
badf=""
for f in $files; do case "$f" in test.sh|*_test.go) ;; *) badf="$badf $f";; esac; done
[ -z "$badf" ]; chk $? "no_solution_code / relevant_files_only" "unexpected files:$badf"

grep -qi '^+.*dockerfile' $P; [ $? -ne 0 ]; chk $? "no_environment_dockerfile" "Dockerfile content inside test patch"

grep -qE '^\+.*(go get|go install|apt-get|apk add|pip install|npm i)' $P; [ $? -ne 0 ]; chk $? "no_package_installation" "installs packages at test time"
grep -qE '^\+.*(curl |wget |\bnc\b |base64 -d|eval \$|rm -rf /)' $P; [ $? -ne 0 ]; chk $? "no_malicious_code" "suspicious command"

grep -qiE 'shipd|olympus|datacurve|quest|challenge|mars' $P; [ $? -ne 0 ]; chk $? "naming_sweep" "platform words leaked into patch"
grep -qE '^(FROM public.ecr.aws/d3j8x8q7/olympus-base)' $D; chk $? "dockerfile_base_image" "wrong base image"

echo; echo "PASS=$ok FAIL=$bad"
