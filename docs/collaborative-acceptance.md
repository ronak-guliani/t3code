# Collaborative acceptance settings

The server owns collaborative acceptance policy selection. When a new case is
created, it captures the currently saved policy and canonical review workflow.
If the setting is not configured (`null`), the server rejects new case
initiation. An explicit `off` policy permits case tracking and manual review
requests but disables automatic review admission.

Existing cases keep their captured policy. Changing settings affects only new
cases; candidate submissions cannot mutate an existing case's contract.

Bounded and until-ready automation admit eligible candidates according to the
configured trigger until a case limit blocks another exchange. A zero model
spend limit means unlimited coordinator accounting units. This ledger is an
admission estimate and is not verified provider billing.
