# herde protocol v2: a pinned copy

`schema.json` and `fixtures/` are copied unchanged from herde **v0.5.1** (`../herde/protocol/`, commit 55c34ff), as ARCHE copies them (`radio-app/server/tests/herde-protocol/README.md`). The contract tests answer each fixture's request in its response's shape.

After a protocol change in herde, copy the files again and update this note. A test that fails then shows where the project side falls behind. `diff -r protocol ../../../herde/protocol` compares this copy with herde's.
