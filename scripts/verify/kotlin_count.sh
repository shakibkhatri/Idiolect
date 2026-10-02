#!/bin/sh
# Regex second opinion for Kotlin. Declarations at any indent, so expect small differences on local funs and functions inside strings.
files="$@"
echo "funs $(cat $files | grep -cE '^\s*(override |private |internal |protected |public |suspend |inline |operator |infix |open |abstract |actual |expect |tailrec |external )*fun\b')"
echo "classes $(cat $files | grep -cE '^\s*(private |internal |public |open |abstract |sealed |data |enum |annotation |inner |value |actual |expect )*(class|interface|object)\b')  sealedInterface $(cat $files | grep -cE '\bsealed interface\b')  sealedClass $(cat $files | grep -cE '\bsealed class\b')  dataClasses $(cat $files | grep -cE '\bdata class\b')"
echo "lineComments $(cat $files | grep -cE '^\s*//')  kdocStarts $(cat $files | grep -cE '^\s*/\*\*')"
echo "try $(cat $files | grep -cE '^\s*try\s*\{')  runCatching $(cat $files | grep -cE '\brunCatching\b')  forceUnwrap $(cat $files | grep -oE '!!' | wc -l | tr -d ' ')"
echo "composables $(cat $files | grep -cE '^\s*@Composable')  remember $(cat $files | grep -oE '\bremember[A-Z]?[A-Za-z]*\s*(\(|\{)' | wc -l | tr -d ' ')"
echo "when $(cat $files | grep -cE '\bwhen\s*(\(|\{)')"
