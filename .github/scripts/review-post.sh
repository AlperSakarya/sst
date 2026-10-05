#!/usr/bin/env bash
# Posts the automatic review on a pull request: one comment, updated on each
# run, the risk label, and a `review` status on the latest commit.
#
# Needs GH_TOKEN, GH_REPO, PR, SHA, OUT, MODEL and RUN_URL, and the files
# review-prepare.sh wrote in $OUT. $OUT/review.raw is opencode's output, used
# only when OPENCODE_OUTCOME is "success". DRY_RUN=1 prints instead of posting.
set -euo pipefail

marker="<!-- sst-community-review -->"
risk=$(cat "$OUT/risk")
failed=$(cat "$OUT/failed")

# The model's review, from its Summary heading on. Colors are stripped and
# mentions broken, so the text can't ping anyone.
review=""
verdict=""
if [ "${OPENCODE_OUTCOME:-}" = success ] && [ -s "$OUT/review.raw" ]; then
  review=$(perl -CS -pe 's/\e\[[0-9;]*m//g; s/@(?=\w)/@\x{200B}/g' <"$OUT/review.raw" |
    awk '/^#+ *Summary/{on=1} on' | head -c 50000)
  verdict=$(grep -Eio 'VERDICT:[[:space:]]*`?(approve|changes)' <<<"$review" | tail -1 | grep -Eio 'approve|changes' | tr 'A-Z' 'a-z' || true)
fi

if [ "$failed" -gt 0 ]; then
  state=failure
  description="$failed check(s) failed. See the review comment."
elif [ "$verdict" = changes ]; then
  state=failure
  description="The review asks for changes. See the review comment."
elif [ -z "$review" ]; then
  state=success
  description="Checks passed. The AI review didn't run."
elif [ -z "$verdict" ]; then
  state=success
  description="Checks passed. The review gave no verdict; read it."
else
  state=success
  description="Checks passed, and the review has no blocking findings."
fi

{
  echo "$marker"
  echo "## Automatic review"
  echo
  if [ "$state" = failure ]; then
    echo "**Before a committer reviews this, please fix the ❌ checks and the findings below**, or reply if you disagree. Pushing a fix runs this again."
    echo
  fi
  echo "**Risk:** $(cat "$OUT/risk.md")"
  echo
  echo "**Checks**"
  echo
  cat "$OUT/checks.md"
  echo
  if [ -n "$review" ]; then
    echo "$review"
  else
    echo "_The AI review didn't run this time ([run]($RUN_URL)). The checks above still apply._"
  fi
  echo
  echo "<sub>A first pass by [opencode](https://opencode.ai) with the free \`$MODEL\` model ([run]($RUN_URL)). It can be wrong. A committer still reviews and approves every pull request. Pushing, or editing the title or description, runs it again.</sub>"
} >"$OUT/comment.md"

if [ -n "${DRY_RUN:-}" ]; then
  echo "status: $state - $description"
  echo "label: risk: $risk"
  echo "--- comment:"
  cat "$OUT/comment.md"
  exit 0
fi

# One comment per pull request, updated in place.
id=$(gh api --paginate "repos/$GH_REPO/issues/$PR/comments" \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" | head -1)
if [ -n "$id" ]; then
  gh api -X PATCH "repos/$GH_REPO/issues/comments/$id" -F "body=@$OUT/comment.md" >/dev/null
else
  gh api -X POST "repos/$GH_REPO/issues/$PR/comments" -F "body=@$OUT/comment.md" >/dev/null
fi

# Exactly one risk label.
for other in low medium high; do
  [ "$other" = "$risk" ] && continue
  if gh api "repos/$GH_REPO/issues/$PR/labels" --jq '.[].name' | grep -qx "risk: $other"; then
    gh api -X DELETE "repos/$GH_REPO/issues/$PR/labels/risk:%20$other" >/dev/null
  fi
done
gh api -X POST "repos/$GH_REPO/issues/$PR/labels" -f "labels[]=risk: $risk" >/dev/null

gh api -X POST "repos/$GH_REPO/statuses/$SHA" -f state="$state" -f context=review \
  -f description="$description" -f target_url="$RUN_URL" >/dev/null
