"""Independent Python counts via the stdlib ast module, same definitions as idiolect's analyzer."""
import ast, sys, json, tokenize, io

out = dict(files=0, functions=0, params={}, classes=0, doc=0, tryCatch=0, typeHinted=0, fStrings=0, formatCalls=0, comprehensions=0, bareExcepts=0, dataclasses=0, hashComments=0, publicDecls=0, publicDocumented=0, privateDecls=0, privateDocumented=0, testFunctions=0)

def private(name): return name.startswith("_") and not name.startswith("__")
def decl(name, node):
    k = "private" if private(name) else "public"
    out[k + "Decls"] += 1
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) and ast.get_docstring(node, clean=False) is not None:
        out[k + "Documented"] += 1

for path in sys.argv[1:]:
    src = open(path).read()
    tree = ast.parse(src)
    out["files"] += 1
    is_test = path.split("/")[-1].startswith("test_") or path.endswith("_test.py") or "/tests/" in path or "/test/" in path
    out["hashComments"] += sum(1 for t in tokenize.generate_tokens(io.StringIO(src).readline) if t.type == tokenize.COMMENT)
    if ast.get_docstring(tree, clean=False) is not None: out["doc"] += 1
    def scope_decls(body, cls):
        for st in body:
            if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)): decl(st.name, st)
            elif isinstance(st, ast.Assign) and len(st.targets) == 1 and isinstance(st.targets[0], ast.Name): decl(st.targets[0].id, st)
            elif isinstance(st, ast.AnnAssign) and isinstance(st.target, ast.Name): decl(st.target.id, st)
    scope_decls(tree.body, False)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            out["functions"] += 1
            if is_test: out["testFunctions"] += 1
            args = node.args
            allargs = [a for a in args.posonlyargs + args.args + args.kwonlyargs if a.arg not in ("self", "cls")] + ([args.vararg] if args.vararg else []) + ([args.kwarg] if args.kwarg else [])
            out["params"][str(len(allargs))] = out["params"].get(str(len(allargs)), 0) + 1
            if node.returns is not None or any(a.annotation is not None for a in allargs): out["typeHinted"] += 1
            if ast.get_docstring(node, clean=False) is not None: out["doc"] += 1
        elif isinstance(node, ast.ClassDef):
            out["classes"] += 1
            if ast.get_docstring(node, clean=False) is not None: out["doc"] += 1
            if any((isinstance(d, ast.Name) and d.id == "dataclass") or (isinstance(d, ast.Attribute) and d.attr == "dataclass") or (isinstance(d, ast.Call) and getattr(d.func, "id", getattr(d.func, "attr", "")) == "dataclass") for d in node.decorator_list): out["dataclasses"] += 1
            scope_decls(node.body, True)
        elif isinstance(node, ast.Try): out["tryCatch"] += 1
        elif isinstance(node, ast.ExceptHandler) and node.type is None: out["bareExcepts"] += 1
        elif isinstance(node, ast.JoinedStr): out["fStrings"] += 1
        elif isinstance(node, (ast.ListComp, ast.DictComp, ast.SetComp, ast.GeneratorExp)): out["comprehensions"] += 1
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "format" and isinstance(node.func.value, ast.Constant) and isinstance(node.func.value.value, str): out["formatCalls"] += 1
print(json.dumps(out))
