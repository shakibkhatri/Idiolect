#!/bin/sh
# Regex second opinion for Go, no toolchain on this machine. Top-level decls only, so it is close, not exact.
files="$@"
echo "funcs $(cat $files | grep -cE '^func ')"
echo "structs $(cat $files | grep -cE '^type [A-Za-z_]+ struct')  interfaces $(cat $files | grep -cE '^type [A-Za-z_]+ interface')  types $(cat $files | grep -cE '^type ')"
echo "errChecks $(cat $files | grep -cE 'if .*err != nil')  panics $(cat $files | grep -cE '\bpanic\(')"
echo "lineComments $(cat $files | grep -cE '^\s*//')"
echo "exportedFuncs $(cat $files | grep -cE '^func (\([^)]*\) )?[A-Z]')  unexportedFuncs $(cat $files | grep -cE '^func (\([^)]*\) )?[a-z]')"
echo "typeAssertions $(cat $files | grep -oE '\.\([A-Za-z*\[\]]+\)' | wc -l | tr -d ' ')"
