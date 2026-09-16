"use strict";

function customInstructions(input) {
  return input.instructions ? `\nImportant! Custom Instructions:\n${input.instructions}\n` : "";
}

function readinessSummary(input) {
  const readiness = input.readiness;
  if (!readiness) return "";
  const checks = readiness.checks || {};
  const review = readiness.reviewDecision ? String(readiness.reviewDecision).toLowerCase() : "no decision";
  return `   Launch state: mergeable=${readiness.mergeable || "unknown"}, status=${readiness.mergeStateStatus || "unknown"}, `
    + `checks ${checks.passing || 0} passing / ${checks.pending || 0} pending / ${checks.failing || 0} failing, review ${review}.\n`;
}

function pushTarget(input) {
  if (!input.crossRepository) {
    return input.headRefName
      ? `its own head branch \`${input.headRefName}\`, for example \`git push origin HEAD:${input.headRefName}\``
      : "its own head branch so the existing pull request updates";
  }
  const fork = input.headRepository
    ? `${input.headRepository}${input.headRefName ? `/${input.headRefName}` : ""}`
    : "the fork head";
  return input.maintainerCanModify
    ? `the existing head branch in ${fork} (maintainer edits are allowed, so add the fork as a remote and push there)`
    : `the fork head ${fork} only if you can push to it; otherwise stop and ask`;
}

function headAccess(input) {
  if (!input.crossRepository) {
    return `The head is this repository's own branch${input.headRefName ? ` \`${input.headRefName}\`` : ""}; update the existing pull request in place.`;
  }
  const fork = input.headRepository || "a fork";
  if (input.maintainerCanModify) return `The head is a fork (${fork}) that allows maintainer edits; update the existing pull request in place.`;
  return `The head is a fork (${fork}) that does not allow maintainer edits. Stop and ask before changing anything; only if told to proceed, push a new branch and open a replacement pull request that preserves the original commit authorship.`;
}

function issuePrompt(input) {
  return `You are investigating issue ${input.target.url} on repository ${input.repo}.

1. Investigate and reproduce the issue before editing. Use $ask-pro:ask-pro only if the problem is genuinely difficult.
2. Prepare the smallest complete fix and run $review-suite:review-plan before implementation.
3. Implement and validate the fix. Keep it minimal and avoid unrelated changes.
4. Run $ponytail:ponytail-review once, then $review-suite:review (note: herdrdev/herdr uses mode fast).
5. Push the branch and open a pull request. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the root cause, fix, validation, review state, and pull-request URL.
${customInstructions(input)}`;
}

function taskPrompt(input) {
  return `You are implementing this request on repository ${input.repo}:

${input.request}

1. Investigate the repository and choose the smallest correct approach before editing.
2. If the plan is tricky, use $ask-pro:ask-pro before implementation; otherwise run $review-suite:review-plan.
3. Implement and validate the change. Keep it minimal and avoid unrelated changes.
4. Run $ponytail:ponytail-review once, then $review-suite:review (note: herdrdev/herdr uses mode fast).
5. Push the branch and open a pull request. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the approach, implementation, validation, review state, and pull-request URL.
`;
}

function prPrompt(input) {
  return `You are bringing pull request ${input.prUrl} on repository ${input.repo} to a mergeable state, keeping the work on the existing pull request.

1. Inspect the complete pull request before editing: description, commits, diff, mergeability, checks, reviews, open review comments (including unresolved Greptile/CodeRabbit comments), and whether it is behind its base. Re-check with the GitHub CLI; treat the launch state below as a starting point only.
${readinessSummary(input)}2. ${headAccess(input)}
3. Classify and act:
   - Behind its base and rebasing cleanly: rebase onto the current base.
   - Rebase conflicts, failing checks, unresolved review findings, or conflicts introduced by the pull request: take over — triage and resolve conflicts, and fix only what is required to make it mergeable, keeping changes in the spirit of the pull request.
   - Checks still pending: wait and re-classify before changing anything.
   - Required human review missing: make the change code-complete and report that a human reviewer is the remaining step; never claim you approved it.
   - Already green, approved, and current: validate and sign off without changing code.
4. If your changes materially alter the diff, run $ponytail:ponytail-review once, then $review-suite:review (note: herdrdev/herdr uses mode fast). A mechanical rebase or trivial fix does not need them.
5. Push to ${pushTarget(input)}. Do not merge; open a replacement pull request only when you cannot push to the existing head and the user approved it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. When the custom instructions ask for review only or no changes, stay strictly read-only.
7. Leave a concise recap: the classification, what you changed, validation, the pull-request URL, and anything that still needs a human decision.
${customInstructions(input)}`;
}

function opencodeIssuePrompt(input) {
  return `You are investigating issue ${input.target.url} on repository ${input.repo}.

1. Investigate and reproduce the issue before editing.
2. Prepare the smallest complete fix and write a brief plan before implementation.
3. Implement and validate the fix. Keep it minimal and avoid unrelated changes.
4. Review your own diff for correctness and unrequested changes before finishing.
5. Push the branch and open a pull request with the GitHub CLI. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the root cause, fix, validation, review state, and pull-request URL.
${customInstructions(input)}`;
}

function opencodeTaskPrompt(input) {
  return `You are implementing this request on repository ${input.repo}:

${input.request}

1. Investigate the repository and choose the smallest correct approach before editing.
2. Write a brief plan before implementation.
3. Implement and validate the change. Keep it minimal and avoid unrelated changes.
4. Review your own diff for correctness and unrequested changes before finishing.
5. Push the branch and open a pull request with the GitHub CLI. Do not merge it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. Leave a concise recap with the approach, implementation, validation, review state, and pull-request URL.
`;
}

function opencodePrPrompt(input) {
  return `You are bringing pull request ${input.prUrl} on repository ${input.repo} to a mergeable state, keeping the work on the existing pull request.

1. Inspect the complete pull request before editing: description, commits, diff, mergeability, checks, reviews, open review comments (including unresolved automated-reviewer comments), and whether it is behind its base. Re-check with the GitHub CLI; treat the launch state below as a starting point only.
${readinessSummary(input)}2. ${headAccess(input)}
3. Classify and act:
   - Behind its base and rebasing cleanly: rebase onto the current base.
   - Rebase conflicts, failing checks, unresolved review findings, or conflicts introduced by the pull request: take over — triage and resolve conflicts, and fix only what is required to make it mergeable, keeping changes in the spirit of the pull request.
   - Checks still pending: wait and re-classify before changing anything.
   - Required human review missing: make the change code-complete and report that a human reviewer is the remaining step; never claim you approved it.
   - Already green, approved, and current: validate and sign off without changing code.
4. Keep the diff minimal and avoid unrelated changes.
5. Push to ${pushTarget(input)}. Do not merge; open a replacement pull request only when you cannot push to the existing head and the user approved it. Handle CI and any automated reviewers present; verify findings and reply to every addressed inline comment.
6. When the custom instructions ask for review only or no changes, stay strictly read-only.
7. Leave a concise recap: the classification, what you changed, validation, the pull-request URL, and anything that still needs a human decision.
${customInstructions(input)}`;
}

const CODEX_PROMPTS = { issue: issuePrompt, task: taskPrompt, pr: prPrompt };
const OPENCODE_PROMPTS = { issue: opencodeIssuePrompt, task: opencodeTaskPrompt, pr: opencodePrPrompt };

module.exports = {
  issuePrompt, prPrompt, taskPrompt,
  opencodeIssuePrompt, opencodePrPrompt, opencodeTaskPrompt,
  CODEX_PROMPTS, OPENCODE_PROMPTS,
};
