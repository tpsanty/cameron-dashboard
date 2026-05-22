#!/usr/bin/env bash
# Reads hook JSON from stdin, stages + commits + pushes the changed file.
f=$(node -e "
  let d = '';
  process.stdin.on('data', c => d += c);
  process.stdin.on('end', () => {
    try {
      const j = JSON.parse(d);
      process.stdout.write((j.tool_input && j.tool_input.file_path) || '');
    } catch (e) {}
  });
")

[ -z "$f" ] && exit 0

cd "C:/Users/santy/Desktop/cameron-dashboard" || exit 1

git add "$f"
git diff --cached --quiet && exit 0   # nothing staged — file unchanged, skip

git commit -m "Auto: $(basename "$f")"
git push 2>/dev/null || true
