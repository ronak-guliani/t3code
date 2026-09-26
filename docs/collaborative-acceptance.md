# Collaborative acceptance settings

The server owns collaborative acceptance policy selection. When a new case is
created, it captures the currently saved policy and canonical review workflow.
If the setting is not configured (`null`), the server rejects new case
initiation. An explicit `off` policy permits case tracking and manual review
requests but disables automatic review admission.

Existing cases keep their captured policy. Changing settings affects only new
cases; candidate submissions cannot mutate an existing case's contract.

For a pull request associated with its creating T3 thread, the server
reconciles automatic review from durable state after the thread becomes
inactive. Only associations sourced as `created` or `agent` participate;
manual and recovered links never start this flow. Each reconciliation refreshes
the pull request and binds admission to its current open head, so a restart,
event reordering, or repeated sweep cannot create duplicate review state.
Unconfigured, `off`, and `manual` policies fail closed. `first-candidate`
admits only the first eligible candidate, while
`each-eligible-candidate` may admit later eligible heads.

Bounded and until-ready automation admit eligible candidates according to the
configured trigger until a case limit blocks another exchange. A zero model
spend limit means unlimited coordinator accounting units. This ledger is an
admission estimate and is not verified provider billing.
