/**
 * The work plan as a card needs it. A plan that is done is never opened again
 * (the review dialog is reached only from a plan waiting for approval, or one
 * running, stopped or failed), and the cards of finished tasks only count its
 * steps: so those go out as ids and statuses. With hundreds of finished tasks
 * their texts and step details were 8 MB of the state sent to every page.
 */
export function publicWorkPlan(plan) {
  if (plan.status === 'done') {
    return {
      id: plan.id, version: plan.version ?? null, feedback: null, status: plan.status, slim: true,
      tasks: plan.tasks.map((x) => ({ id: x.id, status: x.status })),
    };
  }
  return {
    id: plan.id, version: plan.version ?? null, feedback: plan.feedback ?? null, status: plan.status, text: plan.text, waves: plan.waves, selected: plan.selected,
    tasks: plan.tasks.map((x) => ({
      id: x.id, what: x.what, files: x.files, dependsOn: x.dependsOn, check: x.check, status: x.status,
      attempts: x.attempts, extraRetries: x.extraRetries ?? 0, startedAt: x.startedAt, endedAt: x.endedAt,
      lastFailure: x.lastFailure ? { kind: x.lastFailure.kind, output: String(x.lastFailure.output ?? '').split(/\r?\n/).slice(-20).join('\n') } : null,
      summary: x.summary ? String(x.summary).slice(0, 400) : null,
    })),
  };
}
